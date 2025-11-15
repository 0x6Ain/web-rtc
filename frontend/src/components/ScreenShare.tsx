import { useEffect, useState, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket } from '../utils/socket';
import './ScreenShare.css';

// 타입 정의
interface ScreenShareState {
  isSharing: boolean;
  error: string | null;
}

interface UseScreenShareReturn extends ScreenShareState {
  startSharing: () => void;
  stopSharing: () => void;
  stream: MediaStream | null;
}

// 에러 메시지 상수
const ERROR_MESSAGES = {
  PERMISSION_DENIED: '화면 공유 권한이 거부되었습니다.',
  DEVICE_NOT_FOUND: '화면 공유 장치를 찾을 수 없습니다.',
  NO_VIDEO_TRACK: '화면 공유 스트림에 비디오 트랙이 없습니다.',
  NO_ACTIVE_TRACK: '활성화된 비디오 트랙이 없습니다.',
  TRACK_ADD_FAILED: '트랙을 추가할 수 없습니다.',
  TRACK_NOT_ADDED: '비디오 트랙이 PeerConnection에 추가되지 않았습니다.',
  TRACK_NOT_ACTIVE: '트랙이 활성화되지 않았습니다.',
  NO_VIDEO_IN_OFFER: '비디오 트랙이 Offer에 포함되지 않았습니다.',
  CONNECTION_FAILED: '연결 설정에 실패했습니다.',
  OFFER_CREATE_FAILED: 'Offer 생성에 실패했습니다.',
  SHARING_FAILED: '화면 공유를 시작할 수 없습니다.',
  CONNECTION_LOST: '연결이 끊어졌습니다.',
  SHARING_STOPPED: '화면 공유가 중단되었습니다.',
} as const;

// 화면 공유 설정
const SCREEN_SHARE_CONFIG = {
  video: {
    displaySurface: 'monitor' as const,
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  },
  audio: false,
} as const;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * 화면 공유 커스텀 훅
 */
function useScreenShare(): UseScreenShareReturn {
  const [state, setState] = useState<ScreenShareState>({
    isSharing: false,
    error: null,
  });
  const [stream, setStream] = useState<MediaStream | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const isSharingRef = useRef(false);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // 상태 업데이트 헬퍼
  const updateState = useCallback((updates: Partial<ScreenShareState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  // 에러 처리 헬퍼
  const handleError = useCallback((error: string) => {
    console.error('ScreenShare Error:', error);
    updateState({ error, isSharing: false });
    isSharingRef.current = false;
  }, [updateState]);

  // PeerConnection 생성
  const createPeerConnection = useCallback((): RTCPeerConnection => {
    // 기존 연결 정리
    if (peerConnectionRef.current) {
      console.log('기존 PeerConnection 닫기');
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // ICE candidate 큐 초기화
    iceCandidateQueueRef.current = [];

    console.log('새 PeerConnection 생성');
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // ICE candidate 처리
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current?.connected) {
        console.log('ICE candidate 전송');
        socketRef.current.emit('webrtc-ice-candidate', {
          candidate: event.candidate,
        });
      }
    };

    // 연결 상태 모니터링
    pc.onconnectionstatechange = () => {
      const connectionState = pc.connectionState;
      console.log('연결 상태:', connectionState);

      if (connectionState === 'connected') {
        console.log('WebRTC 연결 성공!');
      } else if (connectionState === 'failed' || connectionState === 'disconnected') {
        handleError(ERROR_MESSAGES.CONNECTION_LOST);
      }
    };

    // ICE 연결 상태 모니터링
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log('ICE 연결 상태:', iceState);

      if (iceState === 'connected' || iceState === 'completed') {
        console.log('ICE 연결 완료!');
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [handleError]);

  // 화면 공유 스트림 가져오기
  const getScreenStream = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_SHARE_CONFIG);
      console.log('화면 공유 스트림 획득:', stream);

      // 비디오 트랙에 이벤트 리스너 추가
      stream.getVideoTracks().forEach((track) => {
        console.log('트랙 초기 상태:', {
          id: track.id,
          readyState: track.readyState,
          enabled: track.enabled,
        });

        track.onended = () => {
          console.log('화면 공유 트랙이 종료되었습니다:', track.id);
          handleError(ERROR_MESSAGES.SHARING_STOPPED);

          // PeerConnection에서 트랙 제거
          if (peerConnectionRef.current) {
            const senders = peerConnectionRef.current.getSenders();
            senders.forEach((sender) => {
              if (sender.track === track) {
                peerConnectionRef.current?.removeTrack(sender);
                console.log('트랙 제거 완료');
              }
            });
          }
        };

        track.onmute = () => {
          console.log('트랙이 음소거되었습니다:', track.id);
        };

        track.onunmute = () => {
          console.log('트랙 음소거 해제:', track.id);
        };
      });

      return stream;
    } catch (err: any) {
      console.error('화면 공유 실패:', err);

      let errorMessage: string = ERROR_MESSAGES.SHARING_FAILED;
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMessage = ERROR_MESSAGES.PERMISSION_DENIED;
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMessage = ERROR_MESSAGES.DEVICE_NOT_FOUND;
      } else if (err.message) {
        errorMessage = `화면 공유 실패: ${err.message}`;
      }

      handleError(errorMessage);
      return null;
    }
  }, [handleError]);

  // 트랙을 PeerConnection에 추가하고 검증
  const addTrackToPeerConnection = useCallback(
    (pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): boolean => {
      try {
        pc.addTrack(track, stream);
        console.log('비디오 트랙 추가 완료');

        // 트랙이 제대로 추가되었는지 확인
        const senders = pc.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === 'video');

        if (!videoSender || !videoSender.track) {
          handleError(ERROR_MESSAGES.TRACK_NOT_ADDED);
          return false;
        }

        console.log('송신자 트랙 상태:', {
          id: videoSender.track.id,
          readyState: videoSender.track.readyState,
          enabled: videoSender.track.enabled,
        });

        if (videoSender.track.readyState !== 'live') {
          handleError(ERROR_MESSAGES.TRACK_NOT_ACTIVE);
          return false;
        }

        return true;
      } catch (err) {
        console.error('트랙 추가 실패:', err);
        handleError(ERROR_MESSAGES.TRACK_ADD_FAILED);
        return false;
      }
    },
    [handleError]
  );

  // Offer 생성 및 전송
  const createAndSendOffer = useCallback(
    async (pc: RTCPeerConnection): Promise<boolean> => {
      try {
        console.log('Offer 생성 시작...');
        const offer = await pc.createOffer();
        console.log('Offer 생성 완료:', offer.type);

        // Offer SDP에 비디오 트랙이 포함되어 있는지 확인
        const hasVideoInSDP = offer.sdp?.includes('m=video') || false;
        console.log('Offer SDP에 비디오 포함:', hasVideoInSDP);
        console.log('=== Offer SDP 전체 (처음 1000자) ===');
        console.log(offer.sdp?.substring(0, 1000));
        console.log('=== Offer SDP 끝 ===');

        if (!hasVideoInSDP) {
          console.error('Offer SDP에 비디오 트랙이 포함되지 않았습니다!');
          console.log('Offer SDP 전체:', offer.sdp);
          handleError(ERROR_MESSAGES.NO_VIDEO_IN_OFFER);
          return false;
        }

        await pc.setLocalDescription(offer);
        console.log('Local description 설정 완료');
        console.log('setLocalDescription 후 시그널링 상태:', pc.signalingState);

        if (pc.signalingState !== 'have-local-offer') {
          console.error('잘못된 시그널링 상태:', pc.signalingState);
          handleError(ERROR_MESSAGES.CONNECTION_FAILED);
          return false;
        }

        // 트랙 상태 최종 확인
        const finalSender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (!finalSender?.track || finalSender.track.readyState !== 'live') {
          console.error('트랙이 종료되었습니다!');
          handleError(ERROR_MESSAGES.SHARING_STOPPED);
          return false;
        }

        if (!socketRef.current) {
          console.error('소켓이 초기화되지 않았습니다.');
          handleError(ERROR_MESSAGES.CONNECTION_FAILED);
          return false;
        }

        // 소켓 연결 상태 확인
        if (!socketRef.current.connected) {
          console.warn('소켓이 연결되지 않았습니다. 연결 대기 중...');
          
          // 연결 대기 (최대 5초)
          return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              console.error('소켓 연결 시간 초과');
              handleError('서버에 연결할 수 없습니다. 백엔드 서버가 실행 중인지 확인하세요.');
              resolve(false);
            }, 5000);

            const onConnect = () => {
              console.log('소켓 연결 완료, Offer 전송 재시도');
              clearTimeout(timeout);
              
              if (socketRef.current) {
                socketRef.current.off('connect', onConnect);
                socketRef.current.emit('webrtc-offer', { offer });
                console.log('Offer 전송 완료');
                console.log('Offer 전송 후 시그널링 상태:', pc.signalingState);
                resolve(true);
              } else {
                resolve(false);
              }
            };

            if (socketRef.current) {
              socketRef.current.once('connect', onConnect);
            } else {
              clearTimeout(timeout);
              resolve(false);
            }
          });
        }

        socketRef.current.emit('webrtc-offer', { offer });
        console.log('Offer 전송 완료');
        console.log('Offer 전송 후 시그널링 상태:', pc.signalingState);

        return true;
      } catch (err) {
        console.error('Offer 생성 실패:', err);
        handleError(ERROR_MESSAGES.OFFER_CREATE_FAILED);
        return false;
      }
    },
    [handleError]
  );

  // 화면 공유 시작
  const startSharing = useCallback(async () => {
    console.log('화면 공유 시작');

    // 이미 공유 중이면 중복 실행 방지
    if (isSharingRef.current && peerConnectionRef.current?.signalingState !== 'closed') {
      console.warn('이미 PeerConnection이 활성화되어 있습니다.');
      return;
    }

    // 새 PeerConnection 생성
    const pc = createPeerConnection();

    try {
      // 화면 공유 스트림 가져오기
      const stream = await getScreenStream();
      if (!stream) {
        return;
      }

      screenStreamRef.current = stream;
      setStream(stream); // state 업데이트로 미리보기 표시

      // 비디오 트랙 확인
      const videoTracks = stream.getVideoTracks();
      console.log('비디오 트랙 개수:', videoTracks.length);

      if (videoTracks.length === 0) {
        handleError(ERROR_MESSAGES.NO_VIDEO_TRACK);
        return;
      }

      // 활성 트랙 찾기
      const activeTrack = videoTracks.find((track) => track.readyState === 'live');
      if (!activeTrack) {
        handleError(ERROR_MESSAGES.NO_ACTIVE_TRACK);
        return;
      }

      console.log('활성 트랙 정보:', {
        id: activeTrack.id,
        kind: activeTrack.kind,
        enabled: activeTrack.enabled,
        readyState: activeTrack.readyState,
        muted: activeTrack.muted,
      });

      // 트랙을 PeerConnection에 추가
      if (!addTrackToPeerConnection(pc, activeTrack, stream)) {
        return;
      }

      // 트랙이 추가된 직후 상태 재확인
      const senders = pc.getSenders();
      const videoSender = senders.find((s) => s.track?.kind === 'video');
      if (!videoSender?.track || videoSender.track.readyState !== 'live') {
        console.error('트랙이 live 상태가 아닙니다:', videoSender?.track?.readyState);
        handleError(ERROR_MESSAGES.TRACK_NOT_ACTIVE);
        return;
      }

      // Offer 생성 및 전송 (트랙이 live 상태인지 확인한 직후)
      const success = await createAndSendOffer(pc);
      if (success) {
        updateState({ isSharing: true, error: null });
        isSharingRef.current = true;
      }
    } catch (err) {
      console.error('화면 공유 시작 실패:', err);
      handleError(ERROR_MESSAGES.SHARING_FAILED);
    }
  }, [createPeerConnection, getScreenStream, addTrackToPeerConnection, createAndSendOffer, updateState, handleError]);

  // 화면 공유 중지
  const stopSharing = useCallback(() => {
    console.log('화면 공유 중지');

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }
    setStream(null); // state 초기화

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    updateState({ isSharing: false, error: null });
    isSharingRef.current = false;
  }, [updateState]);

  // 큐에 있는 ICE candidate들을 처리
  const processIceCandidateQueue = useCallback(async (pc: RTCPeerConnection) => {
    if (iceCandidateQueueRef.current.length === 0) {
      console.log('큐에 ICE candidate가 없습니다.');
      return;
    }

    if (!pc.remoteDescription) {
      console.warn('Remote description이 아직 설정되지 않아 큐 처리를 지연합니다.');
      return;
    }

    console.log(`✅ 큐에 있는 ${iceCandidateQueueRef.current.length}개의 ICE candidate 처리 시작...`);
    const candidates = [...iceCandidateQueueRef.current];
    iceCandidateQueueRef.current = [];

    let successCount = 0;
    let failCount = 0;

    for (const candidateData of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateData));
        successCount++;
        console.log(`✅ 큐에서 ICE candidate 추가 완료 (${successCount}/${candidates.length})`);
      } catch (err) {
        failCount++;
        console.error(`❌ 큐에서 ICE candidate 추가 실패 (${failCount}/${candidates.length}):`, err);
      }
    }

    console.log(`✅ 큐 처리 완료: 성공 ${successCount}개, 실패 ${failCount}개`);
  }, []);

  // Answer 수신 처리
  const handleAnswer = useCallback(
    async (data: { answer: RTCSessionDescriptionInit }) => {
      console.log('Answer 수신:', data);

      const pc = peerConnectionRef.current;
      if (!pc) {
        console.error('PeerConnection이 null입니다!');
        return;
      }

      console.log('현재 PeerConnection 상태:', {
        signalingState: pc.signalingState,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
      });

      if (pc.signalingState === 'closed') {
        console.error('PeerConnection이 닫혀있습니다!');
        return;
      }

      if (pc.signalingState !== 'have-local-offer') {
        console.error('잘못된 시그널링 상태:', pc.signalingState);
        console.error('Answer를 받으려면 have-local-offer 상태여야 합니다.');
        return;
      }

      try {
        console.log('Answer 설정 시작...');
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        console.log('✅ Answer 설정 완료');
        console.log('새로운 시그널링 상태:', pc.signalingState);
        console.log('Remote description 설정됨:', !!pc.remoteDescription);
        
        // Answer 설정 후 큐에 있는 ICE candidate들 처리
        // 약간의 지연을 두어 remote description이 완전히 설정되도록 함
        setTimeout(async () => {
          await processIceCandidateQueue(pc);
        }, 100);
      } catch (err) {
        console.error('Answer 설정 실패:', err);
        handleError(ERROR_MESSAGES.CONNECTION_FAILED);
      }
    },
    [handleError, processIceCandidateQueue]
  );

  // ICE candidate 수신 처리
  const handleIceCandidate = useCallback(async (data: { candidate: RTCIceCandidateInit }) => {
    console.log('ICE candidate 수신:', data);

    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('PeerConnection이 null입니다!');
      return;
    }

    if (pc.signalingState === 'closed') {
      console.error('PeerConnection이 닫혀있습니다!');
      return;
    }

    // Remote description이 없으면 큐에 추가
    if (!pc.remoteDescription) {
      console.warn('Remote description이 아직 설정되지 않았습니다. ICE candidate를 큐에 추가합니다.');
      iceCandidateQueueRef.current.push(data.candidate);
      console.log(`큐에 추가됨. 현재 큐 크기: ${iceCandidateQueueRef.current.length}`);
      return;
    }

    // Remote description이 있으면 즉시 추가
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log('ICE candidate 추가 완료');
    } catch (err) {
      console.error('ICE candidate 추가 실패:', err);
      // 실패한 경우 큐에 추가하여 나중에 재시도
      iceCandidateQueueRef.current.push(data.candidate);
    }
  }, []);

  // 초기화 및 이벤트 리스너 설정
  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    // 소켓 연결 상태 확인 및 로깅
    if (socket.connected) {
      console.log('✅ 소켓이 이미 연결되어 있습니다.');
    } else {
      console.warn('⚠️ 소켓이 연결되지 않았습니다. 연결 대기 중...');
    }

    // 소켓 연결 이벤트 리스너
    const handleConnect = () => {
      console.log('✅ 소켓 연결 완료');
    };

    const handleDisconnect = () => {
      console.warn('⚠️ 소켓 연결이 끊어졌습니다.');
    };

    const handleConnectError = (error: Error) => {
      console.error('❌ 소켓 연결 오류:', error);
      handleError('서버에 연결할 수 없습니다. 백엔드 서버가 실행 중인지 확인하세요.');
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);

    // WebRTC 이벤트 리스너 등록
    socket.on('webrtc-answer', handleAnswer);
    socket.on('webrtc-ice-candidate', handleIceCandidate);

    // 정리 함수
    return () => {
      console.log('ScreenShare cleanup');
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('webrtc-answer', handleAnswer);
      socket.off('webrtc-ice-candidate', handleIceCandidate);

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, [handleAnswer, handleIceCandidate, handleError]);

  // 화면 공유 시작 이벤트 리스너
  useEffect(() => {
    const handleStartEvent = () => {
      console.log('화면 공유 시작 이벤트 수신');
      startSharing();
    };

    window.addEventListener('start-screen-share', handleStartEvent);
    return () => {
      window.removeEventListener('start-screen-share', handleStartEvent);
    };
  }, [startSharing]);

  return {
    isSharing: state.isSharing,
    error: state.error,
    startSharing,
    stopSharing,
    stream,
  };
}

/**
 * ScreenShare 컴포넌트
 */
function ScreenShare() {
  const { isSharing, error, stopSharing, stream } = useScreenShare();
  const previewRef = useRef<HTMLVideoElement>(null);

  const handleStartSharing = useCallback(() => {
    if (isSharing) {
      console.log('이미 화면 공유 중입니다.');
      return;
    }

    console.log('화면 공유 버튼 클릭');
    window.dispatchEvent(new CustomEvent('start-screen-share'));
  }, [isSharing]);

  // 화면 공유 스트림을 미리보기에 표시
  useEffect(() => {
    if (stream && previewRef.current) {
      console.log('미리보기에 스트림 설정:', stream.id);
      const video = previewRef.current;
      
      // 기존 스트림 제거
      if (video.srcObject) {
        const oldStream = video.srcObject as MediaStream;
        oldStream.getTracks().forEach(track => {
          track.onended = null;
          track.onmute = null;
          track.onunmute = null;
        });
      }
      
      video.srcObject = stream;
      video.muted = true; // 자동 재생을 위해 음소거
      
      const playVideo = async () => {
        try {
          await video.play();
          console.log('✅ 미리보기 재생 성공');
        } catch (err: any) {
          console.error('미리보기 재생 실패:', err);
          if (err.name === 'NotAllowedError') {
            console.warn('자동 재생이 차단되었습니다. 사용자 상호작용이 필요합니다.');
          }
        }
      };
      
      playVideo();
      
      // 스트림 상태 모니터링 및 복구
      const checkStreamHealth = () => {
        if (!video || !stream) return;
        
        const tracks = stream.getVideoTracks();
        const activeTracks = tracks.filter(t => t.readyState === 'live' && t.enabled);
        
        // 스트림이 비활성화되었거나 트랙이 없는 경우
        if (!stream.active || activeTracks.length === 0) {
          console.warn('⚠️ 스트림이 비활성화되었습니다. 복구 시도...');
          
          // 스트림이 여전히 존재하고 트랙이 있으면 재설정
          if (tracks.length > 0) {
            const liveTrack = tracks.find(t => t.readyState === 'live');
            if (liveTrack) {
              console.log('🔄 live 트랙 발견, 스트림 재설정');
              video.srcObject = stream;
              playVideo();
            }
          }
        }
        
        // 비디오가 일시정지되었고 스트림이 활성화되어 있으면 재생 시도
        if (video.paused && stream.active && activeTracks.length > 0) {
          console.log('🔄 비디오가 일시정지됨, 재생 시도');
          playVideo();
        }
      };
      
      // 주기적으로 스트림 상태 확인 (2초마다)
      const healthCheckInterval = setInterval(checkStreamHealth, 2000);
      
      // 트랙 종료 감지
      const tracks = stream.getVideoTracks();
      tracks.forEach(track => {
        track.onended = () => {
          console.warn('⚠️ 트랙이 종료됨:', track.id);
          checkStreamHealth();
        };
        
        track.onmute = () => {
          console.warn('⚠️ 트랙이 음소거됨:', track.id);
        };
        
        track.onunmute = () => {
          console.log('✅ 트랙 음소거 해제:', track.id);
          playVideo();
        };
      });
      
      // 비디오 이벤트 리스너
      const handlePlay = () => {
        console.log('✅ 미리보기 재생 시작');
      };
      
      const handlePause = () => {
        console.warn('⚠️ 미리보기 일시정지됨');
        if (stream.active) {
          setTimeout(() => playVideo(), 100);
        }
      };
      
      const handleStalled = () => {
        console.warn('⚠️ 미리보기 버퍼링 중...');
      };
      
      const handleError = () => {
        console.error('❌ 미리보기 오류 발생');
        checkStreamHealth();
      };
      
      video.addEventListener('play', handlePlay);
      video.addEventListener('pause', handlePause);
      video.addEventListener('stalled', handleStalled);
      video.addEventListener('error', handleError);
      
      return () => {
        clearInterval(healthCheckInterval);
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('stalled', handleStalled);
        video.removeEventListener('error', handleError);
      };
    } else if (!stream && previewRef.current) {
      // 스트림이 없으면 비디오 요소 초기화
      previewRef.current.srcObject = null;
    }
  }, [stream]);

  if (error) {
    return (
      <div className="screen-share error">
        <div className="error-message">
          <h3>오류 발생</h3>
          <p>{error}</p>
          <button onClick={() => window.location.reload()} className="btn-retry">
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-share">
      <div className="screen-share-container">
        {stream && (
          <div className="preview-container">
            <h3>공유 중인 화면 미리보기</h3>
            <video
              ref={previewRef}
              autoPlay
              muted
              playsInline
              className="preview-video"
            />
          </div>
        )}
        {isSharing ? (
          <div className="sharing-status">
            <div className="status-indicator active"></div>
            <p>화면 공유 중...</p>
            <p className="info-text">
              다른 브라우저에서 <strong>http://localhost:5173/</strong>에 접속하여 화면을 확인하세요.
            </p>
            <button onClick={stopSharing} className="btn-stop">
              공유 중지
            </button>
          </div>
        ) : (
          <div className="sharing-status">
            <h2>화면 공유 시작하기</h2>
            <p className="info-text">
              화면 공유를 시작하면 다른 브라우저에서 이 화면을 볼 수 있습니다.
            </p>
            <button onClick={handleStartSharing} className="btn-start">
              화면 공유 시작
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScreenShare;
