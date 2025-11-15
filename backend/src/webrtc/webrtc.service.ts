import { Injectable, Logger } from '@nestjs/common';
import { CaptureService } from '../capture/capture.service';

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

type RTCPeerConnection = any;
type MediaStreamTrack = any;
type RTCIceCandidate = any;

@Injectable()
export class WebrtcService {
  private readonly logger = new Logger(WebrtcService.name);
  private peerConnections = new Map<string, RTCPeerConnection>();

  constructor(private readonly captureService: CaptureService) {}

  /**
   * 새로운 WebRTC PeerConnection을 생성합니다.
   * 주의: wrtc 패키지가 빌드되지 않으면 동작하지 않습니다.
   */
  createPeerConnection(
    clientId: string,
    onIceCandidate?: (candidate: RTCIceCandidate) => void,
  ): RTCPeerConnection | null {
    try {
      // wrtc 패키지가 없으면 null 반환
      if (!wrtc || !wrtc.RTCPeerConnection) {
        this.logger.warn('WebRTC 기능은 현재 비활성화되어 있습니다. wrtc 패키지가 로드되지 않았습니다.');
        return null;
      }

      const { RTCPeerConnection } = wrtc;
      
      this.logger.log(`PeerConnection 생성 중: ${clientId}`);
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      pc.onicecandidate = (event: any) => {
        if (event.candidate && onIceCandidate) {
          this.logger.debug(`ICE candidate 생성: ${clientId}`);
          onIceCandidate(event.candidate);
        }
      };

      pc.onconnectionstatechange = () => {
        this.logger.log(`연결 상태 변경 [${clientId}]: ${pc.connectionState}`);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          this.removePeerConnection(clientId);
        }
      };

      // 화면 캡처 트랙 추가
      this.addScreenCaptureTrack(pc, clientId);

      this.peerConnections.set(clientId, pc);
      this.logger.log(`PeerConnection 생성 완료: ${clientId}`);
      return pc;
    } catch (error) {
      this.logger.error(`PeerConnection 생성 실패: ${error}`);
      return null;
    }
  }

  /**
   * PeerConnection을 제거합니다.
   */
  removePeerConnection(clientId: string): void {
    const pc = this.peerConnections.get(clientId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(clientId);
      this.logger.log(`PeerConnection 제거: ${clientId}`);
    }
  }

  /**
   * 특정 클라이언트의 PeerConnection을 가져옵니다.
   */
  getPeerConnection(clientId: string): RTCPeerConnection | undefined {
    return this.peerConnections.get(clientId);
  }

  /**
   * 화면 캡처 트랙을 PeerConnection에 추가합니다.
   */
  private async addScreenCaptureTrack(pc: RTCPeerConnection, clientId: string): Promise<void> {
    try {
      // 화면 캡처 시작
      const videoTrack = await this.captureService.startCapture();
      
      if (videoTrack && pc) {
        // 트랙을 PeerConnection에 추가
        pc.addTrack(videoTrack);
        this.logger.log(`화면 캡처 트랙 추가 완료: ${clientId}`);
      } else {
        this.logger.warn(`화면 캡처 트랙을 가져올 수 없습니다: ${clientId}`);
      }
    } catch (error) {
      this.logger.error(`화면 캡처 트랙 추가 실패 [${clientId}]: ${error}`);
    }
  }
}

