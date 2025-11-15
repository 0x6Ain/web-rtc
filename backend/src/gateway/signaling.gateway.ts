import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WebrtcService } from '../webrtc/webrtc.service';
import { Logger } from '@nestjs/common';

// wrtc 패키지 동적 로드
let wrtc: any = null;
try {
  wrtc = require('@koush/wrtc');
} catch (error) {
  try {
    // fallback to original wrtc
    wrtc = require('wrtc');
  } catch (e) {
    console.warn('wrtc 패키지를 로드할 수 없습니다:', error);
  }
}

// RTCSessionDescription, RTCIceCandidate, MediaStream 타입 정의
const RTCSessionDescription = wrtc?.RTCSessionDescription || class {
  constructor(public sdp: any, public type: string) {}
} as any;

const RTCIceCandidate = wrtc?.RTCIceCandidate || class {
  constructor(public candidate: any) {}
} as any;

const MediaStream = wrtc?.MediaStream || class {
  constructor(public tracks?: any[]) {}
  getTracks() { return this.tracks || []; }
  getVideoTracks() { return (this.tracks || []).filter((t: any) => t.kind === 'video'); }
  getAudioTracks() { return (this.tracks || []).filter((t: any) => t.kind === 'audio'); }
  addTrack(track: any) { if (this.tracks) this.tracks.push(track); }
  removeTrack(track: any) { 
    if (this.tracks) {
      const index = this.tracks.indexOf(track);
      if (index > -1) this.tracks.splice(index, 1);
    }
  }
  get active() { return (this.tracks || []).some((t: any) => t.readyState === 'live'); }
  get id() { return 'fallback-stream-' + Math.random().toString(36).substr(2, 9); }
} as any;

@WebSocketGateway({
  namespace: '/',
  cors: {
    origin: [
      'http://localhost:5173',
      'http://localhost:5000',
      'http://localhost:5200',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5000',
      'http://127.0.0.1:5200',
    ],
    credentials: true,
    methods: ['GET', 'POST'],
  },
})
export class SignalingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SignalingGateway.name);
  private connections = new Map<string, Socket>();
  private pendingOffer: { offer: RTCSessionDescriptionInit; senderId: string } | null = null;
  private senderPeerConnection: RTCPeerConnection | null = null; // /offer 클라이언트와의 연결 (스트림 수신)
  private senderClientId: string | null = null; // 송신 클라이언트 ID
  private receiverPeerConnections = new Map<string, RTCPeerConnection>(); // / 클라이언트들과의 연결 (스트림 전송)
  private receivedStream: MediaStream | null = null; // 서버가 수신한 스트림

  constructor(private readonly webrtcService: WebrtcService) {}

  handleConnection(client: Socket) {
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`🔌 클라이언트 연결: ${client.id}`);
    this.connections.set(client.id, client);
    
    // 자동으로 연결 허용 (스크린 쉐어링 모드)
    this.logger.log(`✅ 자동 연결 허용: ${client.id}`);
    this.handleConnectionAccept(client);
    
    // 수신 클라이언트(/ 페이지)인 경우, 서버가 스트림을 전송할 준비
    // 스트림이 이미 수신되어 있으면 즉시 전송
    if (this.receivedStream) {
      this.logger.log(`📺 [/] 기존 스트림이 있으므로 수신 클라이언트(${client.id})에게 즉시 전송 시작`);
      setTimeout(() => {
        this.createReceiverConnection(client.id);
      }, 500);
    } else {
      this.logger.log(`⏳ [/] 스트림이 아직 없습니다. 스트림이 수신되면 자동으로 전송됩니다: ${client.id}`);
    }
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`클라이언트 연결 해제: ${client.id}`);
    this.connections.delete(client.id);
    
    // 송신 클라이언트(/offer)가 연결 해제된 경우
    if (this.senderClientId === client.id && this.senderPeerConnection) {
      this.senderPeerConnection.close();
      this.senderPeerConnection = null;
      this.senderClientId = null;
      this.receivedStream = null;
      this.logger.log('송신 클라이언트 연결이 해제되었습니다. 스트림을 정리했습니다.');
    }
    
    // 수신 클라이언트(/)가 연결 해제된 경우
    const receiverPC = this.receiverPeerConnections.get(client.id);
    if (receiverPC) {
      receiverPC.close();
      this.receiverPeerConnections.delete(client.id);
      this.logger.log(`수신 클라이언트 연결이 해제되었습니다: ${client.id}`);
    }
  }

  @SubscribeMessage('connection-accept')
  handleConnectionAccept(client: Socket) {
    this.logger.log(`연결 허용: ${client.id}`);
    // 수신 클라이언트(/ 페이지)인 경우, 서버가 스트림을 전송할 준비
    // 송신 클라이언트(/offer 페이지)는 webrtc-offer를 보낼 때 처리됨
    client.emit('start-webrtc');
  }

  @SubscribeMessage('connection-reject')
  handleConnectionReject(client: Socket) {
    this.logger.log(`연결 거부: ${client.id}`);
    client.disconnect();
  }

  @SubscribeMessage('webrtc-offer')
  async handleOffer(client: Socket, payload: { offer: RTCSessionDescriptionInit }) {
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`📥 [/offer] Offer 수신 시작: ${client.id}`);
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (!wrtc || !wrtc.RTCPeerConnection) {
      this.logger.error('❌ wrtc 패키지가 로드되지 않았습니다. 서버에서 스트림을 수신할 수 없습니다.');
      return;
    }

    const { RTCPeerConnection, RTCSessionDescription } = wrtc;

    try {
      // 기존 송신자 연결이 있으면 닫기
      if (this.senderPeerConnection) {
        this.logger.log(`🔄 기존 송신자 연결 종료 중...`);
        this.senderPeerConnection.close();
        this.senderPeerConnection = null;
        this.senderClientId = null;
      }

      // 송신 클라이언트 ID 저장
      this.senderClientId = client.id;
      this.logger.log(`✅ 송신 클라이언트 ID 저장: ${client.id}`);

      // 서버가 /offer 클라이언트로부터 스트림을 수신하기 위한 PeerConnection 생성
      this.logger.log(`🔧 PeerConnection 생성 중...`);
      this.senderPeerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      this.logger.log(`✅ PeerConnection 생성 완료`);

      // 서버가 스트림을 수신
      this.senderPeerConnection.ontrack = (event: any) => {
        this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        this.logger.log(`🎥 [/offer] 서버가 스트림을 수신했습니다!`);
        
        const track = event.track;
        this.logger.log(`📊 수신한 트랙 정보:`);
        this.logger.log(`   - 트랙 종류: ${track.kind}`);
        this.logger.log(`   - 트랙 ID: ${track.id}`);
        this.logger.log(`   - 트랙 상태: ${track.readyState}`);
        this.logger.log(`   - 트랙 활성화: ${track.enabled}`);
        
        // 트랙이 live 상태가 아니면 무시
        if (track.readyState !== 'live') {
          this.logger.warn(`⚠️ [/offer] 트랙이 live 상태가 아닙니다: ${track.readyState}`);
          this.logger.warn(`트랙이 나중에 live 상태가 되면 다시 처리됩니다.`);
          
          // 트랙이 나중에 live 상태가 되면 처리
          track.onended = () => {
            this.logger.error(`❌ [/offer] 트랙이 종료되었습니다: ${track.id}`);
            this.receivedStream = null;
          };
          
          // 트랙 상태 변화 감지
          const checkTrackState = () => {
            if (track.readyState === 'live') {
              this.logger.log(`✅ [/offer] 트랙이 live 상태가 되었습니다!`);
              this.handleTrackReceived(track, event.streams, client.id);
            } else if (track.readyState === 'ended') {
              this.logger.error(`❌ [/offer] 트랙이 ended 상태입니다: ${track.id}`);
            }
          };
          
          // 트랙 상태를 주기적으로 확인 (최대 5초)
          let checkCount = 0;
          const checkInterval = setInterval(() => {
            checkCount++;
            checkTrackState();
            if (track.readyState === 'live' || track.readyState === 'ended' || checkCount >= 50) {
              clearInterval(checkInterval);
            }
          }, 100);
          
          return;
        }
        
        // 트랙이 live 상태이면 처리
        this.handleTrackReceived(track, event.streams, client.id);
      };

      // ICE candidate 처리
      this.senderPeerConnection.onicecandidate = (event: any) => {
        if (event.candidate) {
          this.logger.log(`🔗 [/offer] ICE candidate 생성 → /offer 클라이언트로 전송`);
          client.emit('webrtc-ice-candidate', { candidate: event.candidate });
        } else {
          this.logger.log(`✅ [/offer] ICE candidate 수집 완료`);
        }
      };

      // 연결 상태 모니터링
      this.senderPeerConnection.onconnectionstatechange = () => {
        const state = this.senderPeerConnection?.connectionState;
        this.logger.log(`📡 [/offer] 연결 상태 변경: ${state}`);
        if (state === 'connected') {
          this.logger.log(`✅ [/offer] 서버와 /offer 클라이언트 간 연결 완료!`);
        } else if (state === 'disconnected' || state === 'failed') {
          this.logger.warn(`⚠️ [/offer] 연결 실패 또는 해제: ${state}`);
          this.receivedStream = null;
        }
      };

      // ICE 연결 상태 모니터링
      this.senderPeerConnection.oniceconnectionstatechange = () => {
        const iceState = this.senderPeerConnection?.iceConnectionState;
        this.logger.log(`🧊 [/offer] ICE 연결 상태: ${iceState}`);
        if (iceState === 'connected' || iceState === 'completed') {
          this.logger.log(`✅ [/offer] ICE 연결 완료! 스트림 전송 준비 완료`);
        }
      };

      // Offer를 설정하고 Answer 생성
      this.logger.log(`📝 Remote description 설정 중...`);
      await this.senderPeerConnection.setRemoteDescription(
        new RTCSessionDescription(payload.offer)
      );
      this.logger.log(`✅ Remote description 설정 완료`);
      
      // Answer 생성 전에 receivers에서 트랙 확인
      const receiversBeforeAnswer = this.senderPeerConnection.getReceivers();
      const tracksBeforeAnswer = receiversBeforeAnswer.map(r => r.track).filter(t => t && t.kind === 'video');
      this.logger.log(`📊 Answer 생성 전 receivers 상태: ${tracksBeforeAnswer.length}개 트랙`);
      tracksBeforeAnswer.forEach((t, idx) => {
        this.logger.log(`   트랙 ${idx + 1}: ID=${t.id}, 상태=${t.readyState}, 활성화=${t.enabled}`);
      });
      
      this.logger.log(`📝 Answer 생성 중...`);
      const answer = await this.senderPeerConnection.createAnswer();
      await this.senderPeerConnection.setLocalDescription(answer);
      this.logger.log(`✅ Answer 생성 및 Local description 설정 완료`);
      
      // Answer 생성 후 receivers에서 트랙 재확인
      const receiversAfterAnswer = this.senderPeerConnection.getReceivers();
      const tracksAfterAnswer = receiversAfterAnswer.map(r => r.track).filter(t => t && t.kind === 'video');
      const liveTracksAfterAnswer = tracksAfterAnswer.filter(t => t.readyState === 'live');
      this.logger.log(`📊 Answer 생성 후 receivers 상태: 전체 ${tracksAfterAnswer.length}개, live ${liveTracksAfterAnswer.length}개`);
      tracksAfterAnswer.forEach((t, idx) => {
        this.logger.log(`   트랙 ${idx + 1}: ID=${t.id}, 상태=${t.readyState}, 활성화=${t.enabled}`);
      });
      
      // live 트랙이 있으면 즉시 처리
      if (liveTracksAfterAnswer.length > 0) {
        const liveTrack = liveTracksAfterAnswer[0];
        this.logger.log(`✅ Answer 생성 후 live 트랙 발견! 즉시 처리 (${liveTrack.id})`);
        this.handleTrackReceived(liveTrack, null, client.id);
      } else {
        this.logger.warn(`⚠️ Answer 생성 후 live 트랙이 없습니다. ontrack 이벤트를 기다립니다.`);
      }
      
      // Answer를 /offer 클라이언트에게 전송
      client.emit('webrtc-answer', { answer });
      this.logger.log(`📤 [/offer] Answer를 /offer 클라이언트(${client.id})에게 전송 완료`);
      this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      
    } catch (error) {
      this.logger.error(`❌ [/offer] 서버가 Offer를 처리하는 중 오류 발생: ${error}`);
      this.logger.error(`스택 트레이스:`, error instanceof Error ? error.stack : '');
    }
  }

  @SubscribeMessage('webrtc-answer')
  async handleAnswer(client: Socket, payload: { answer: RTCSessionDescriptionInit }) {
    this.logger.log(`📥 [/] Answer 수신: ${client.id} (수신 클라이언트)`);
    
    // 수신 클라이언트(/ 페이지)가 서버의 offer에 대한 answer를 보낸 경우
    const receiverPC = this.receiverPeerConnections.get(client.id);
    if (receiverPC) {
      try {
        if (!wrtc || !wrtc.RTCSessionDescription) {
          this.logger.error('❌ wrtc 패키지가 로드되지 않았습니다.');
          return;
        }
        
        const { RTCSessionDescription } = wrtc;
        this.logger.log(`📝 [/] Remote description 설정 중... (${client.id})`);
        await receiverPC.setRemoteDescription(new RTCSessionDescription(payload.answer));
        this.logger.log(`✅ [/] 서버가 수신 클라이언트(${client.id})의 Answer를 설정 완료`);
        this.logger.log(`🎬 [/] 스트림 전송 시작! 수신 클라이언트(${client.id})가 비디오를 받을 준비 완료`);
      } catch (error) {
        this.logger.error(`❌ [/] Answer 설정 실패 [${client.id}]: ${error}`);
      }
    } else {
      this.logger.warn(`⚠️ [/] 수신 클라이언트의 PeerConnection을 찾을 수 없습니다: ${client.id}`);
    }
  }

  @SubscribeMessage('webrtc-ice-candidate')
  async handleIceCandidate(client: Socket, payload: { candidate: RTCIceCandidateInit }) {
    if (!wrtc || !wrtc.RTCIceCandidate) {
      this.logger.error('❌ wrtc 패키지가 로드되지 않았습니다.');
      return;
    }

    const { RTCIceCandidate } = wrtc;

    try {
      // 송신 클라이언트(/offer)로부터의 ICE candidate
      if (this.senderPeerConnection && this.senderPeerConnection.remoteDescription) {
        await this.senderPeerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        this.logger.log(`🔗 [/offer] 서버가 송신 클라이언트(${client.id})의 ICE candidate 추가 완료`);
        return;
      }

      // 수신 클라이언트(/)로부터의 ICE candidate
      const receiverPC = this.receiverPeerConnections.get(client.id);
      if (receiverPC && receiverPC.remoteDescription) {
        await receiverPC.addIceCandidate(new RTCIceCandidate(payload.candidate));
        this.logger.log(`🔗 [/] 서버가 수신 클라이언트(${client.id})의 ICE candidate 추가 완료`);
        return;
      }

      this.logger.warn(`⚠️ ICE candidate를 처리할 PeerConnection을 찾을 수 없습니다: ${client.id}`);
    } catch (error) {
      this.logger.error(`❌ ICE candidate 추가 실패 [${client.id}]: ${error}`);
    }
  }

  /**
   * 수신한 트랙을 처리하고 스트림으로 저장
   */
  private handleTrackReceived(track: any, streams: MediaStream[] | null, senderClientId: string): void {
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`🎥 [/offer] 서버가 트랙을 수신했습니다!`);
    
    // 트랙 상태 재확인 (트랙이 전달되는 동안 상태가 변경될 수 있음)
    if (track.readyState !== 'live') {
      this.logger.warn(`⚠️ [/offer] 트랙이 live 상태가 아닙니다: ${track.readyState}`);
      this.logger.warn(`트랙 상태가 live가 될 때까지 대기합니다.`);
      
      // 트랙 상태가 live가 될 때까지 대기 (최대 10초)
      let checkCount = 0;
      const checkInterval = setInterval(() => {
        checkCount++;
        if (track.readyState === 'live') {
          clearInterval(checkInterval);
          this.logger.log(`✅ [/offer] 트랙이 live 상태가 되었습니다! 처리 시작`);
          this.processLiveTrack(track, streams, senderClientId);
        } else if (track.readyState === 'ended' || checkCount >= 100) {
          clearInterval(checkInterval);
          this.logger.error(`❌ [/offer] 트랙이 ended 상태이거나 타임아웃: ${track.readyState}`);
        }
      }, 100);
      return;
    }
    
    this.processLiveTrack(track, streams, senderClientId);
  }

  /**
   * live 상태인 트랙을 처리하고 스트림으로 저장
   */
  private processLiveTrack(track: any, streams: MediaStream[] | null, senderClientId: string): void {
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`🎥 [/offer] 서버가 live 트랙을 처리합니다!`);
    
    // 스트림 생성 또는 기존 스트림에 트랙 추가
    if (streams && streams.length > 0) {
      this.receivedStream = streams[0];
    } else {
      this.receivedStream = new MediaStream([track]);
    }
    
    const tracks = this.receivedStream.getTracks();
    this.logger.log(`📊 수신한 스트림 정보:`);
    this.logger.log(`   - 스트림 ID: ${this.receivedStream.id}`);
    this.logger.log(`   - 스트림 활성 상태: ${this.receivedStream.active}`);
    this.logger.log(`   - 트랙 개수: ${tracks.length}`);
    tracks.forEach((t, index) => {
      this.logger.log(`   - 트랙 ${index + 1}: ${t.kind} (ID: ${t.id}, 상태: ${t.readyState}, 활성화: ${t.enabled})`);
    });
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // 현재 모니터링 중인 트랙을 추적하기 위한 변수 (클로저에서 사용)
    let currentTrack: any = track;
    
    // 트랙 종료 감지
    track.onended = () => {
      this.logger.error(`❌ [/offer] 트랙이 종료되었습니다: ${currentTrack.id}`);
      // 트랙이 종료되어도 스트림을 즉시 null로 설정하지 않고, 
      // senderPeerConnection에서 새로운 트랙이 있는지 확인
      if (this.senderPeerConnection) {
        this.logger.log(`🔄 [/offer] senderPeerConnection에서 새로운 트랙 확인 중...`);
        // senderPeerConnection의 receivers에서 live 트랙 확인
        const receivers = this.senderPeerConnection.getReceivers();
        const allTracks = receivers.map(r => r.track).filter(t => t && t.kind === 'video');
        const liveTracks = allTracks.filter(t => t.readyState === 'live');
        
        this.logger.log(`📊 [/offer] receivers 상태: 전체 ${allTracks.length}개, live ${liveTracks.length}개`);
        
        if (liveTracks.length > 0) {
          const newLiveTrack = liveTracks[0];
          this.logger.log(`✅ [/offer] 새로운 live 트랙 발견! 스트림 업데이트 (${newLiveTrack.id})`);
          currentTrack = newLiveTrack;
          this.receivedStream = new MediaStream([newLiveTrack]);
          // broadcastStreamToReceivers는 renegotiation이 필요하므로 호출하지 않음
          // 새 클라이언트는 createReceiverConnection을 통해 스트림을 받음
        } else {
          this.logger.warn(`⚠️ [/offer] 새로운 live 트랙을 찾을 수 없습니다.`);
          this.receivedStream = null;
        }
      } else {
        this.receivedStream = null;
      }
      
      // 모든 수신 클라이언트에게 스트림 종료 알림
      this.receiverPeerConnections.forEach((pc, clientId) => {
        this.logger.log(`📢 스트림 종료를 수신 클라이언트에게 알림: ${clientId}`);
      });
    };
    
    // 트랙 상태 지속 모니터링 (트랙이 종료되지 않도록)
    const monitorTrack = () => {
      if (!this.senderPeerConnection) {
        this.logger.warn(`⚠️ [/offer] senderPeerConnection이 없습니다. 모니터링 중단`);
        return;
      }
      
      const currentTrackState = currentTrack.readyState;
      this.logger.log(`🔍 [/offer] 트랙 상태 모니터링: ${currentTrackState} (트랙 ID: ${currentTrack.id})`);
      
      // senderPeerConnection의 receivers에서 모든 트랙 확인
      const receivers = this.senderPeerConnection.getReceivers();
      const allTracks = receivers.map(r => r.track).filter(t => t && t.kind === 'video');
      const liveTracks = allTracks.filter(t => t.readyState === 'live');
      
      this.logger.log(`📊 [/offer] receivers 상태: 전체 ${allTracks.length}개, live ${liveTracks.length}개`);
      allTracks.forEach((t, idx) => {
        this.logger.log(`   트랙 ${idx + 1}: ID=${t.id}, 상태=${t.readyState}, 활성화=${t.enabled}`);
      });
      
      if (currentTrackState === 'live' && this.receivedStream) {
        // 현재 트랙이 live 상태인지 확인
        if (currentTrack.readyState === 'live') {
          setTimeout(monitorTrack, 2000); // 2초마다 확인
        } else {
          this.logger.warn(`⚠️ [/offer] 트랙 상태가 변경됨: ${currentTrack.readyState}`);
          // 트랙 상태가 변경되었으므로 receivers에서 live 트랙 찾기
          if (liveTracks.length > 0) {
            const newLiveTrack = liveTracks.find(t => t.id !== currentTrack.id) || liveTracks[0];
            this.logger.log(`✅ [/offer] 새로운 live 트랙 발견! 스트림 업데이트 (${newLiveTrack.id})`);
            currentTrack = newLiveTrack;
            this.receivedStream = new MediaStream([newLiveTrack]);
            // broadcastStreamToReceivers는 renegotiation이 필요하므로 호출하지 않음
            setTimeout(monitorTrack, 2000);
          } else {
            this.logger.error(`❌ [/offer] live 트랙을 찾을 수 없습니다.`);
            this.receivedStream = null;
          }
        }
      } else if (currentTrackState === 'ended') {
        this.logger.warn(`⚠️ [/offer] 트랙이 ended 상태입니다: ${currentTrack.id}`);
        
        if (liveTracks.length > 0) {
          const newLiveTrack = liveTracks.find(t => t.id !== currentTrack.id) || liveTracks[0];
          this.logger.log(`✅ [/offer] 새로운 live 트랙 발견! 스트림 업데이트 (${newLiveTrack.id})`);
          currentTrack = newLiveTrack;
          this.receivedStream = new MediaStream([newLiveTrack]);
          // broadcastStreamToReceivers는 renegotiation이 필요하므로 호출하지 않음
          setTimeout(monitorTrack, 2000);
        } else {
          this.logger.error(`❌ [/offer] live 트랙을 찾을 수 없습니다. receivers에 live 트랙이 없습니다.`);
          // receivers를 주기적으로 확인하여 live 트랙이 나타날 때까지 대기
          let checkCount = 0;
          const checkInterval = setInterval(() => {
            checkCount++;
            if (!this.senderPeerConnection) {
              clearInterval(checkInterval);
              return;
            }
            
            const currentReceivers = this.senderPeerConnection.getReceivers();
            const currentTracks = currentReceivers.map(r => r.track).filter(t => t && t.kind === 'video');
            const currentLiveTracks = currentTracks.filter(t => t.readyState === 'live');
            
            this.logger.log(`🔄 [/offer] live 트랙 확인 중... (시도 ${checkCount}/50)`);
            
            if (currentLiveTracks.length > 0) {
              const foundLiveTrack = currentLiveTracks[0];
              this.logger.log(`✅ [/offer] live 트랙 발견! 스트림 업데이트 (${foundLiveTrack.id})`);
              currentTrack = foundLiveTrack;
              this.receivedStream = new MediaStream([foundLiveTrack]);
              // broadcastStreamToReceivers는 renegotiation이 필요하므로 호출하지 않음
              clearInterval(checkInterval);
              setTimeout(monitorTrack, 2000);
            } else if (checkCount >= 50) {
              this.logger.error(`❌ [/offer] 타임아웃: live 트랙을 찾지 못했습니다.`);
              clearInterval(checkInterval);
              this.receivedStream = null;
            }
          }, 200); // 200ms마다 확인, 최대 10초
        }
      } else {
        // 다른 상태 (new, connecting 등)
        this.logger.log(`⏳ [/offer] 트랙 상태: ${currentTrackState}, 계속 모니터링...`);
        setTimeout(monitorTrack, 1000);
      }
    };
    
    // 모니터링 시작
    this.logger.log(`🔍 [/offer] 트랙 모니터링 시작 (트랙 ID: ${currentTrack.id}, 초기 상태: ${currentTrack.readyState})`);
    monitorTrack();
    
    // broadcastStreamToReceivers는 renegotiation이 필요하므로 호출하지 않음
    // 새 클라이언트는 아래 pending receivers 처리를 통해 스트림을 받음
    
    // 스트림이 없었던 수신 클라이언트들에게도 연결 생성
    this.connections.forEach((socket, clientId) => {
      if (!this.receiverPeerConnections.has(clientId) && clientId !== senderClientId) {
        this.logger.log(`📤 새로 수신된 스트림을 수신 클라이언트에게 전송: ${clientId}`);
        this.createReceiverConnection(clientId);
      }
    });
  }

  /**
   * 수신한 스트림을 모든 수신 클라이언트에게 전송
   */
  private broadcastStreamToReceivers(): void {
    if (!this.receivedStream) {
      this.logger.warn('⚠️ 전송할 스트림이 없습니다.');
      return;
    }

    const receiverCount = this.receiverPeerConnections.size;
    this.logger.log(`📡 [/] 수신 클라이언트 ${receiverCount}개에게 스트림 브로드캐스트 시작`);

    // 모든 수신 클라이언트에게 스트림 전송
    this.receiverPeerConnections.forEach((pc, clientId) => {
      try {
        // 기존 트랙 제거
        const senders = pc.getSenders();
        if (senders.length > 0) {
          this.logger.log(`🔄 [/] 기존 트랙 제거 중... [${clientId}]`);
          senders.forEach(sender => {
            if (sender.track) {
              pc.removeTrack(sender);
            }
          });
        }

        // 새로운 트랙 추가 (live 상태인 트랙만)
        const tracks = this.receivedStream!.getTracks();
        this.logger.log(`📊 [/] 브로드캐스트 전 트랙 상태 확인 [${clientId}]:`, tracks.map(t => ({
          kind: t.kind,
          id: t.id,
          readyState: t.readyState,
          enabled: t.enabled
        })));
        
        const liveTracks = tracks.filter(t => t.readyState === 'live');
        
        if (liveTracks.length === 0) {
          this.logger.warn(`⚠️ [/] live 상태인 트랙이 없습니다 [${clientId}]. 트랙 상태:`, tracks.map(t => t.readyState));
          this.logger.warn(`트랙이 live 상태가 되면 자동으로 추가됩니다.`);
          
          // 트랙이 live 상태가 될 때까지 대기 후 재시도
          let checkCount = 0;
          const checkInterval = setInterval(() => {
            checkCount++;
            if (!this.receivedStream) {
              clearInterval(checkInterval);
              return;
            }
            
            const currentTracks = this.receivedStream.getTracks();
            const currentLiveTracks = currentTracks.filter(t => t.readyState === 'live');
            
            if (currentLiveTracks.length > 0) {
              this.logger.log(`✅ [/] 트랙이 live 상태가 되었습니다! 재시도 중... [${clientId}]`);
              clearInterval(checkInterval);
              
              // 각 수신 클라이언트에게 새로운 MediaStream 생성
              const newStream = new MediaStream(currentLiveTracks);
              this.logger.log(`📺 [/] 브로드캐스트용 새로운 MediaStream 생성 (ID: ${newStream.id})`);
              
              currentLiveTracks.forEach((track) => {
                pc.addTrack(track, newStream);
                this.logger.log(`   ✅ 트랙 추가: ${track.kind} (ID: ${track.id}, 상태: ${track.readyState})`);
              });
            } else if (checkCount >= 100) {
              this.logger.error(`❌ [/] 트랙이 live 상태가 되지 않았습니다 (타임아웃) [${clientId}]`);
              clearInterval(checkInterval);
            }
          }, 100);
        } else {
          this.logger.log(`📺 [/] 스트림 트랙 추가 중... [${clientId}] (live 트랙 개수: ${liveTracks.length}/${tracks.length})`);
          
          // 각 수신 클라이언트에게 새로운 MediaStream 생성
          const newStream = new MediaStream(liveTracks);
          this.logger.log(`📺 [/] 브로드캐스트용 새로운 MediaStream 생성 (ID: ${newStream.id})`);
          
          liveTracks.forEach((track, index) => {
            // 트랙 추가 전에 다시 한 번 상태 확인
            if (track.readyState === 'live') {
              pc.addTrack(track, newStream);
              this.logger.log(`   ✅ 트랙 ${index + 1} 추가: ${track.kind} (ID: ${track.id}, 상태: ${track.readyState})`);
            } else {
              this.logger.warn(`   ⚠️ 트랙 ${index + 1}이 live 상태가 아닙니다: ${track.readyState}`);
            }
          });
        }

        this.logger.log(`✅ [/] 스트림을 수신 클라이언트(${clientId})에게 전송 완료`);
      } catch (error) {
        this.logger.error(`❌ [/] 스트림 전송 실패 [${clientId}]: ${error}`);
      }
    });
    
    this.logger.log(`📡 [/] 브로드캐스트 완료: ${receiverCount}개 클라이언트에게 스트림 전송됨`);
  }

  /**
   * 수신 클라이언트에게 스트림을 전송하기 위한 PeerConnection 생성
   */
  private async createReceiverConnection(clientId: string): Promise<void> {
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`📤 [/] 수신 클라이언트(${clientId})에게 스트림 전송 준비 시작`);
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (!wrtc || !wrtc.RTCPeerConnection) {
      this.logger.error('❌ wrtc 패키지가 로드되지 않았습니다.');
      return;
    }

    const { RTCPeerConnection } = wrtc;
    const client = this.connections.get(clientId);
    if (!client) {
      this.logger.warn(`⚠️ 클라이언트를 찾을 수 없습니다: ${clientId}`);
      return;
    }

    try {
      // 기존 연결이 있으면 닫기
      const existingPC = this.receiverPeerConnections.get(clientId);
      if (existingPC) {
        this.logger.log(`🔄 [/] 기존 PeerConnection 종료 중...`);
        existingPC.close();
      }

      // 새로운 PeerConnection 생성
      this.logger.log(`🔧 [/] PeerConnection 생성 중...`);
      const receiverPC = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      this.logger.log(`✅ [/] PeerConnection 생성 완료`);

      // 수신한 스트림이 있으면 추가 (live 상태인 트랙만)
      if (this.receivedStream) {
        const tracks = this.receivedStream.getTracks();
        this.logger.log(`📊 [/] 스트림 트랙 상태 확인 [${clientId}]:`, tracks.map(t => ({
          kind: t.kind,
          id: t.id,
          readyState: t.readyState,
          enabled: t.enabled
        })));
        
        const liveTracks = tracks.filter(t => t.readyState === 'live');
        
        if (liveTracks.length === 0) {
          this.logger.warn(`⚠️ [/] live 상태인 트랙이 없습니다 [${clientId}]. 트랙 상태:`, tracks.map(t => t.readyState));
          this.logger.warn(`트랙이 live 상태가 되면 자동으로 추가됩니다.`);
          
          // 트랙이 live 상태가 될 때까지 대기 (최대 10초)
          let checkCount = 0;
          const checkInterval = setInterval(() => {
            checkCount++;
            const currentTracks = this.receivedStream?.getTracks() || [];
            const currentLiveTracks = currentTracks.filter(t => t.readyState === 'live');
            
            if (currentLiveTracks.length > 0) {
              this.logger.log(`✅ [/] 트랙이 live 상태가 되었습니다! 추가 중... [${clientId}]`);
              clearInterval(checkInterval);
              
              // 각 수신 클라이언트에게 새로운 MediaStream 생성
              const newStream = new MediaStream(currentLiveTracks);
              this.logger.log(`📺 [/] 새로운 MediaStream 생성 (ID: ${newStream.id})`);
              
              currentLiveTracks.forEach((track) => {
                receiverPC.addTrack(track, newStream);
                this.logger.log(`   ✅ 트랙 추가: ${track.kind} (ID: ${track.id}, 상태: ${track.readyState})`);
              });
            } else if (currentTracks.every(t => t.readyState === 'ended') || checkCount >= 100) {
              this.logger.error(`❌ [/] 트랙이 ended 상태이거나 타임아웃 [${clientId}]`);
              clearInterval(checkInterval);
            }
          }, 100);
        } else {
          this.logger.log(`📺 [/] 스트림 트랙 추가 중... [${clientId}] (live 트랙 개수: ${liveTracks.length}/${tracks.length})`);
          
          // 각 수신 클라이언트에게 새로운 MediaStream 생성
          const newStream = new MediaStream(liveTracks);
          this.logger.log(`📺 [/] 새로운 MediaStream 생성 (ID: ${newStream.id})`);
          
          liveTracks.forEach((track, index) => {
            // 트랙 추가 전에 다시 한 번 상태 확인
            if (track.readyState === 'live') {
              receiverPC.addTrack(track, newStream);
              this.logger.log(`   ✅ 트랙 ${index + 1} 추가: ${track.kind} (ID: ${track.id}, 상태: ${track.readyState})`);
            } else {
              this.logger.warn(`   ⚠️ 트랙 ${index + 1}이 live 상태가 아닙니다: ${track.readyState}`);
            }
          });
          this.logger.log(`✅ [/] 모든 live 스트림 트랙 추가 완료 [${clientId}]`);
        }
      } else {
        this.logger.warn(`⚠️ [/] 전송할 스트림이 없습니다 [${clientId}]. 스트림이 수신되면 자동으로 추가됩니다.`);
      }

      // ICE candidate 처리
      receiverPC.onicecandidate = (event: any) => {
        if (event.candidate) {
          this.logger.log(`🔗 [/] ICE candidate 생성 → 수신 클라이언트(${clientId})로 전송`);
          client.emit('webrtc-ice-candidate', { candidate: event.candidate });
        } else {
          this.logger.log(`✅ [/] ICE candidate 수집 완료 (${clientId})`);
        }
      };

      // 연결 상태 모니터링
      receiverPC.onconnectionstatechange = () => {
        const state = receiverPC.connectionState;
        this.logger.log(`📡 [/] 연결 상태 변경 [${clientId}]: ${state}`);
        if (state === 'connected') {
          this.logger.log(`✅ [/] 서버와 수신 클라이언트(${clientId}) 간 연결 완료! 스트림 전송 중...`);
        } else if (state === 'disconnected' || state === 'failed') {
          this.logger.warn(`⚠️ [/] 연결 실패 또는 해제 [${clientId}]: ${state}`);
          this.receiverPeerConnections.delete(clientId);
        }
      };

      // ICE 연결 상태 모니터링
      receiverPC.oniceconnectionstatechange = () => {
        const iceState = receiverPC.iceConnectionState;
        this.logger.log(`🧊 [/] ICE 연결 상태 [${clientId}]: ${iceState}`);
        if (iceState === 'connected' || iceState === 'completed') {
          this.logger.log(`✅ [/] ICE 연결 완료! 수신 클라이언트(${clientId})로 스트림 전송 중...`);
        }
      };

      this.receiverPeerConnections.set(clientId, receiverPC);

      // Offer 생성 및 전송
      this.logger.log(`📝 [/] Offer 생성 중...`);
      const offer = await receiverPC.createOffer();
      await receiverPC.setLocalDescription(offer);
      this.logger.log(`✅ [/] Offer 생성 및 Local description 설정 완료`);
      
      client.emit('webrtc-offer', { offer });
      this.logger.log(`📤 [/] Offer를 수신 클라이언트(${clientId})에게 전송 완료`);
      this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    } catch (error) {
      this.logger.error(`❌ [/] 수신 클라이언트 연결 생성 실패 [${clientId}]: ${error}`);
      this.logger.error(`스택 트레이스:`, error instanceof Error ? error.stack : '');
    }
  }
}

