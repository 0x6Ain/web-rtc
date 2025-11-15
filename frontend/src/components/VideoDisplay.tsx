import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket } from '../utils/socket';
import './VideoDisplay.css';

interface VideoDisplayProps {
  onDisconnect: () => void;
}

function VideoDisplay({ onDisconnect }: VideoDisplayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWaiting, setIsWaiting] = useState(true);
  const [hasStream, setHasStream] = useState(false);
  const [isMuted, setIsMuted] = useState(true); // 자동 재생을 위해 초기값을 음소거로 설정
  const [needsUserInteraction, setNeedsUserInteraction] = useState(false);

  useEffect(() => {
    // 전역 Socket 인스턴스 사용
    const socket = getSocket();
    let pc: RTCPeerConnection | null = null;

    // PeerConnection 생성 함수
    const createPeerConnection = () => {
      if (pc && pc.signalingState !== 'closed') {
        return pc;
      }

      // 기존 연결이 있으면 닫기
      if (pc) {
        pc.close();
      }

      // 새로운 PeerConnection 생성
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      // 원격 스트림 수신
      pc.ontrack = (event) => {
        console.log('=== 트랙 수신 이벤트 (ontrack) ===');
        console.log('트랙:', event.track);
        console.log('트랙 종류:', event.track.kind);
        console.log('트랙 ID:', event.track.id);
        console.log('트랙 enabled:', event.track.enabled);
        console.log('트랙 readyState:', event.track.readyState);
        console.log('트랙 muted:', event.track.muted);
        console.log('스트림:', event.streams);
        console.log('스트림 개수:', event.streams.length);
        if (pc) {
          console.log('연결 상태:', pc.connectionState);
          console.log('ICE 연결 상태:', pc.iceConnectionState);
        }
        
        // 트랙이 ended 상태로 수신된 경우 처리
        if (event.track.readyState === 'ended') {
          console.warn('⚠️ 트랙이 ended 상태로 수신되었습니다.');
          console.warn('이는 WebRTC 연결이 제대로 설정되지 않았거나, 트랙이 제대로 전달되지 않았을 수 있습니다.');
          if (pc) {
            console.warn('연결 상태:', pc.connectionState);
            console.warn('ICE 연결 상태:', pc.iceConnectionState);
            console.warn('시그널링 상태:', pc.signalingState);
          }
          
          // 트랙이 나중에 live 상태가 될 수 있으므로 주기적으로 확인
          if (pc && event.track.kind === 'video') {
            console.log('⏳ 트랙이 live 상태가 될 때까지 주기적으로 확인합니다...');
            let checkCount = 0;
            const maxChecks = 50; // 최대 5초간 확인 (100ms * 50)
            
            const checkTrackState = setInterval(() => {
              checkCount++;
              
              if (!pc) {
                clearInterval(checkTrackState);
                return;
              }
              
              // 수신자에서 live 트랙 확인
              const receivers = pc.getReceivers();
              const liveVideoTrack = receivers
                .map(r => r.track)
                .find(track => track && track.kind === 'video' && track.readyState === 'live');
              
              if (liveVideoTrack) {
                console.log('✅ live 트랙 발견! 스트림 설정 시도');
                clearInterval(checkTrackState);
                
                const stream = new MediaStream([liveVideoTrack]);
                if (videoRef.current) {
                  videoRef.current.srcObject = stream;
                  videoRef.current.muted = isMuted;
                  setHasStream(true);
                  setIsWaiting(false);
                  videoRef.current.play().catch(err => {
                    console.error('비디오 재생 실패:', err);
                    if (err.name === 'NotAllowedError') {
                      setNeedsUserInteraction(true);
                    }
                  });
                }
              } else if (checkCount >= maxChecks) {
                console.warn('⏱️ 타임아웃: live 트랙을 찾지 못했습니다.');
                clearInterval(checkTrackState);
                
                // ICE 연결이 완료되었는지 확인
                if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                  console.warn('연결은 완료되었지만 live 비디오 트랙이 없습니다.');
                  console.warn('수신자 상태:', receivers.map(r => ({
                    kind: r.track?.kind,
                    readyState: r.track?.readyState
                  })));
                }
              }
            }, 100); // 100ms마다 확인
          }
          
          // ended 상태의 트랙도 일단 반환 (나중에 live 상태가 될 수 있음)
          // 하지만 즉시 스트림 설정은 하지 않음
          return;
        }
        
        if (event.track.kind === 'video' && event.track.readyState === 'live') {
          console.log('✅ 비디오 트랙 수신! (live 상태)');
          
          // videoRef가 준비될 때까지 대기
          const setVideoStream = () => {
            if (!videoRef.current) {
              console.log('videoRef가 아직 준비되지 않음, 100ms 후 재시도...');
              setTimeout(setVideoStream, 100);
              return;
            }
            
            let streamToUse: MediaStream | null = null;
            
            if (event.streams && event.streams.length > 0) {
              streamToUse = event.streams[0];
              console.log('스트림 사용:', streamToUse);
            } else if (event.track && event.track.readyState === 'live') {
              // 스트림이 없으면 트랙으로부터 스트림 생성 (live 상태일 때만)
              streamToUse = new MediaStream([event.track]);
              console.log('트랙으로부터 스트림 생성:', streamToUse);
            } else {
              console.error('트랙이 live 상태가 아닙니다:', event.track.readyState);
              return;
            }
            
            if (streamToUse && videoRef.current) {
              // 기존 스트림이 있으면 트랙 이벤트 리스너 제거
              if (videoRef.current.srcObject) {
                const oldStream = videoRef.current.srcObject as MediaStream;
                oldStream.getTracks().forEach(track => {
                  track.onended = null;
                  track.onmute = null;
                  track.onunmute = null;
                });
              }
              
              videoRef.current.srcObject = streamToUse;
              console.log('✅ 비디오 요소에 스트림 설정 완료');
              console.log('비디오 요소 srcObject:', videoRef.current.srcObject);
              console.log('스트림의 트랙:', streamToUse.getTracks().map(t => ({
                id: t.id,
                kind: t.kind,
                enabled: t.enabled,
                readyState: t.readyState
              })));
              
              // 트랙 종료 감지 및 처리
              streamToUse.getTracks().forEach(track => {
                track.onended = () => {
                  console.error('⚠️ 비디오 트랙이 종료되었습니다:', track.id);
                  console.error('트랙 상태:', {
                    id: track.id,
                    kind: track.kind,
                    readyState: track.readyState,
                    enabled: track.enabled
                  });
                  
                  // 트랙이 종료되면 수신자에서 다시 확인
                  setTimeout(() => {
                    if (!pc) return;
                    const receivers = pc.getReceivers();
                    receivers.forEach((receiver) => {
                      const receiverTrack = receiver.track;
                      if (receiverTrack && receiverTrack.kind === 'video' && receiverTrack.readyState === 'live') {
                        console.log('🔄 종료된 트랙 대신 live 트랙 발견, 스트림 재설정');
                        const newStream = new MediaStream([receiverTrack]);
                        if (videoRef.current) {
                          videoRef.current.srcObject = newStream;
                          videoRef.current.play().catch(err => {
                            console.error('비디오 재생 실패:', err);
                          });
                        }
                      }
                    });
                  }, 500);
                };
                
                track.onmute = () => {
                  console.warn('트랙이 음소거되었습니다:', track.id);
                };
                
                track.onunmute = () => {
                  console.log('트랙 음소거 해제:', track.id);
                };
              });
              
              setHasStream(true);
              setIsWaiting(false);
              
              // 비디오 요소가 표시되는지 확인
              console.log('비디오 요소 표시 상태:', {
                display: window.getComputedStyle(videoRef.current).display,
                visibility: window.getComputedStyle(videoRef.current).visibility,
                width: videoRef.current.offsetWidth,
                height: videoRef.current.offsetHeight
              });
              
              // 비디오 재생 시도 (음소거 상태로 시작하여 자동 재생 허용)
              const playVideo = async () => {
                try {
                  // 음소거 상태로 재생 시도 (자동 재생 정책 우회)
                  if (videoRef.current) {
                    videoRef.current.muted = isMuted;
                    console.log('비디오 음소거 설정:', isMuted);
                  }
                  
                  // 약간의 지연을 두어 스트림이 준비될 시간을 줌
                  await new Promise(resolve => setTimeout(resolve, 100));
                  
                  await videoRef.current!.play();
                  console.log('✅ 비디오 재생 성공!');
                  console.log('재생 후 비디오 상태:', {
                    paused: videoRef.current!.paused,
                    readyState: videoRef.current!.readyState,
                    videoWidth: videoRef.current!.videoWidth,
                    videoHeight: videoRef.current!.videoHeight
                  });
                  setNeedsUserInteraction(false);
                } catch (err: any) {
                  console.error('비디오 재생 실패:', err);
                  if (err.name === 'NotAllowedError') {
                    console.warn('비디오 재생 권한이 필요합니다.');
                    setNeedsUserInteraction(true);
                    // 사용자 상호작용을 기다림
                    const playOnInteraction = () => {
                      if (videoRef.current && !videoRef.current.paused) return;
                      videoRef.current?.play().catch(() => {});
                      setNeedsUserInteraction(false);
                      document.removeEventListener('click', playOnInteraction);
                      document.removeEventListener('touchstart', playOnInteraction);
                    };
                    document.addEventListener('click', playOnInteraction, { once: true });
                    document.addEventListener('touchstart', playOnInteraction, { once: true });
                  } else {
                    setNeedsUserInteraction(true);
                  }
                }
              };
              playVideo();
            } else {
              console.error('스트림을 설정할 수 없습니다.');
            }
          };
          
          setVideoStream();
        } else if (event.track.kind === 'video') {
          console.warn('비디오 트랙이지만 live 상태가 아닙니다:', event.track.readyState);
        } else {
          console.log('비디오가 아닌 트랙:', event.track.kind);
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && socket.connected) {
          socket.emit('webrtc-ice-candidate', {
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc) {
          const state = pc.connectionState;
          console.log('연결 상태:', state);
          if (state === 'connected') {
            console.log('✅ WebRTC 연결 성공!');
            // 연결 성공 후 스트림 확인
            setTimeout(() => {
              if (!pc || !videoRef.current) return;
              const receivers = pc.getReceivers();
              receivers.forEach((receiver) => {
                const track = receiver.track;
                if (track && track.kind === 'video' && track.readyState === 'live') {
                  const stream = new MediaStream([track]);
                  if (videoRef.current && (!videoRef.current.srcObject || 
                      (videoRef.current.srcObject as MediaStream).getTracks().length === 0)) {
                    console.log('🔄 연결 성공 후 스트림 재설정');
                    videoRef.current.srcObject = stream;
                    videoRef.current.play().catch(err => {
                      console.error('비디오 재생 실패:', err);
                    });
                  }
                }
              });
            }, 500);
          } else if (state === 'disconnected') {
            console.warn('⚠️ 연결이 끊어졌습니다. 재연결 시도 중...');
            // 연결이 끊어졌지만 실패로 처리하지 않고 재연결 시도
            setIsWaiting(true);
          } else if (state === 'failed') {
            console.error('❌ 연결 실패');
            setError('연결이 실패했습니다.');
            setIsWaiting(true);
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc) {
          const iceState = pc.iceConnectionState;
          console.log('ICE 연결 상태:', iceState);
          if (iceState === 'connected' || iceState === 'completed') {
            console.log('✅ ICE 연결 완료!');
            // ICE 연결이 완료되면 ontrack 이벤트에서 이미 스트림이 설정되었으므로
            // 여기서는 추가 작업 불필요
          } else if (iceState === 'failed' || iceState === 'disconnected') {
            console.error('ICE 연결 실패 또는 연결 해제:', iceState);
            // 연결이 끊어졌지만 재연결 시도
            setIsWaiting(true);
          }
        }
      };

      setPeerConnection(pc);
      return pc;
    };

    // 시그널링 이벤트 처리 (수신만 - 서버에서 offer를 받음)
    const handleStartWebrtc = async () => {
      console.log('WebRTC 수신 준비 (서버로부터 스트림을 받을 준비)');
      
      // PeerConnection이 없거나 닫혀있으면 새로 생성
      if (!pc || pc.signalingState === 'closed') {
        pc = createPeerConnection();
      }

      // 수신 모드이므로 offer 생성하지 않음
      // 서버에서 offer를 받으면 answer를 생성
      console.log('화면 공유 대기 중... 서버로부터 offer를 기다립니다.');
    };

    socket.on('start-webrtc', handleStartWebrtc);
    
    // 이미 연결되어 있으면 초기 PeerConnection 생성
    if (socket.connected) {
      console.log('서버에 이미 연결되어 있습니다.');
      pc = createPeerConnection();
      setTimeout(() => {
        handleStartWebrtc();
      }, 500);
    } else {
      // 연결 대기
      socket.once('connect', () => {
        console.log('서버에 연결되었습니다.');
        pc = createPeerConnection();
        setTimeout(() => {
          handleStartWebrtc();
        }, 500);
      });
    }

    socket.on('error', (error: { message: string }) => {
      console.error('서버 오류:', error.message);
      if (error.message.includes('WebRTC')) {
        setError('WebRTC 기능이 서버에서 비활성화되어 있습니다. 화면 스트리밍을 사용할 수 없습니다.');
      }
    });

    socket.on('webrtc-answer', async (data: { answer: RTCSessionDescriptionInit }) => {
      console.log('Answer 수신:', data);
      if (!pc || pc.signalingState === 'closed') {
        console.warn('PeerConnection이 없거나 닫혀있습니다.');
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('Answer 설정 실패:', err);
        setError('연결 설정에 실패했습니다.');
      }
    });

    const handleOffer = async (data: { offer: RTCSessionDescriptionInit }) => {
      console.log('Offer 수신:', data);
      setIsWaiting(false);
      
      // Offer SDP 확인
      console.log('Offer SDP (처음 500자):', data.offer.sdp?.substring(0, 500));
      const hasVideoInOffer = data.offer.sdp?.includes('m=video') || false;
      console.log('Offer에 비디오 포함:', hasVideoInOffer);
      
      // PeerConnection이 없으면 생성 (또는 기존 연결이 닫혀있으면 새로 생성)
      if (!pc || pc.signalingState === 'closed' || pc.connectionState === 'closed') {
        console.log('PeerConnection 생성 중...');
        if (pc) {
          pc.close();
        }
        pc = createPeerConnection();
      }
      
      try {
        console.log('Remote description 설정 중...');
        console.log('현재 시그널링 상태:', pc.signalingState);
        
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        console.log('Remote description 설정 완료');
        console.log('설정 후 시그널링 상태:', pc.signalingState);
        
        console.log('Answer 생성 중...');
        const answer = await pc.createAnswer();
        console.log('Answer 생성 완료, SDP 확인:', answer.sdp?.substring(0, 300));
        await pc.setLocalDescription(answer);
        console.log('Local description 설정 완료');
        
        socket.emit('webrtc-answer', { answer });
        console.log('Answer 전송 완료');
        
        // 연결 상태 확인
        console.log('현재 연결 상태:', pc.connectionState);
        console.log('현재 ICE 연결 상태:', pc.iceConnectionState);
        console.log('현재 시그널링 상태:', pc.signalingState);
        
        // 트랙은 ICE 연결이 완료된 후에 활성화되므로, 
        // ontrack 이벤트나 ICE 연결 완료 후에 처리됨
        // 여기서는 트랙 확인만 수행 (실제 설정은 ontrack 또는 ICE 연결 완료 후)
        
        // 트랙을 비디오 요소에 설정하는 함수
        // ontrack 이벤트에서 이미 스트림이 설정되므로
        // 추가 트랙 설정 로직은 불필요함 (제거됨)
      } catch (err) {
        console.error('Answer 생성 실패:', err);
        setError('연결 설정에 실패했습니다.');
        setIsWaiting(true);
      }
    };

    socket.on('webrtc-offer', handleOffer);

    socket.on('webrtc-ice-candidate', async (data: { candidate: RTCIceCandidateInit }) => {
      console.log('ICE candidate 수신:', data);
      if (!pc || pc.signalingState === 'closed') {
        console.warn('PeerConnection이 없거나 닫혀있습니다.');
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('ICE candidate 추가 실패:', err);
      }
    });

    setSocket(socket);

    return () => {
      // 이벤트 리스너만 제거 (Socket 인스턴스는 유지)
      socket.off('start-webrtc');
      socket.off('error');
      socket.off('webrtc-answer');
      socket.off('webrtc-offer');
      socket.off('webrtc-ice-candidate');
      if (pc) {
        pc.close();
        pc = null;
      }
    };
  }, []);

  // 트랙 상태를 지속적으로 모니터링하고 자동으로 복구
  useEffect(() => {
    if (!peerConnection || !hasStream) return;

    const monitorInterval = setInterval(() => {
      if (!peerConnection) {
        clearInterval(monitorInterval);
        return;
      }

      // 현재 비디오 스트림 확인
      const currentStream = videoRef.current?.srcObject as MediaStream | null;
      let needsRestore = false;

      if (currentStream) {
        const tracks = currentStream.getTracks();
        const videoTrack = tracks.find(t => t.kind === 'video');
        
        // 트랙이 ended 상태이거나 스트림이 비활성화된 경우
        if (videoTrack && (videoTrack.readyState === 'ended' || !currentStream.active)) {
          console.warn('⚠️ 비디오 트랙이 ended 상태이거나 스트림이 비활성화됨');
          console.warn('트랙 상태:', {
            readyState: videoTrack.readyState,
            enabled: videoTrack.enabled,
            streamActive: currentStream.active
          });
          needsRestore = true;
        }
      } else {
        // 스트림이 없는 경우
        needsRestore = true;
      }

      // 트랙 복구 시도
      if (needsRestore) {
        const receivers = peerConnection.getReceivers();
        const liveVideoTrack = receivers
          .map(r => r.track)
          .find(track => track && track.kind === 'video' && track.readyState === 'live');

        if (liveVideoTrack) {
          console.log('🔄 live 트랙 발견, 스트림 재설정');
          const newStream = new MediaStream([liveVideoTrack]);
          
          if (videoRef.current) {
            // 기존 스트림의 트랙 이벤트 리스너 제거
            if (currentStream) {
              currentStream.getTracks().forEach(track => {
                track.onended = null;
                track.onmute = null;
                track.onunmute = null;
              });
            }

            videoRef.current.srcObject = newStream;
            
            // 트랙 이벤트 리스너 설정
            liveVideoTrack.onended = () => {
              console.warn('⚠️ 트랙이 종료됨, 다음 모니터링 주기에서 복구 시도');
            };

            // 재생 중이 아니면 재생 시도
            if (videoRef.current.paused) {
              videoRef.current.play().catch(err => {
                console.error('트랙 복구 후 재생 실패:', err);
              });
            }

            setHasStream(true);
            setIsWaiting(false);
            console.log('✅ 트랙 복구 완료');
          }
        } else {
          // live 트랙이 없으면 연결 상태 확인
          if (peerConnection.iceConnectionState === 'connected' || 
              peerConnection.iceConnectionState === 'completed') {
            console.warn('⚠️ 연결은 유지되지만 live 비디오 트랙이 없음');
            console.warn('수신자 개수:', receivers.length);
            receivers.forEach((receiver, index) => {
              const track = receiver.track;
              if (track) {
                console.warn(`수신자 ${index}:`, {
                  kind: track.kind,
                  readyState: track.readyState,
                  enabled: track.enabled
                });
              }
            });
          }
        }
      }
    }, 2000); // 2초마다 확인

    return () => {
      clearInterval(monitorInterval);
    };
  }, [peerConnection, hasStream]);

  const handleFullscreen = () => {
    if (!videoRef.current) return;

    if (!isFullscreen) {
      if (videoRef.current.requestFullscreen) {
        videoRef.current.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
    setIsFullscreen(!isFullscreen);
  };

  const handleDisconnect = () => {
    if (peerConnection) {
      peerConnection.close();
    }
    if (socket) {
      socket.close();
    }
    onDisconnect();
  };

  if (error) {
    return (
      <div className="video-display error">
        <div className="error-message">
          <h3>오류 발생</h3>
          <p>{error}</p>
          <div className="error-actions">
            <button onClick={() => {
              setError(null);
              window.location.reload();
            }} className="btn-retry">
              다시 시도
            </button>
            <button onClick={handleDisconnect} className="btn-disconnect">
              닫기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 비디오 요소는 항상 렌더링 (ref가 설정되도록)
  // isWaiting 상태는 오버레이로 표시

  return (
    <div className="video-display">
      <div className="video-container">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isMuted}
          className="video-stream"
          style={{ 
            display: hasStream ? 'block' : 'none',
            visibility: hasStream ? 'visible' : 'hidden'
          }}
          onLoadedMetadata={() => {
            console.log('비디오 메타데이터 로드 완료');
            if (videoRef.current) {
              const state = {
                videoWidth: videoRef.current.videoWidth,
                videoHeight: videoRef.current.videoHeight,
                paused: videoRef.current.paused,
                muted: videoRef.current.muted,
                readyState: videoRef.current.readyState,
                currentTime: videoRef.current.currentTime,
                duration: videoRef.current.duration,
                srcObject: videoRef.current.srcObject ? 'MediaStream' : null,
                offsetWidth: videoRef.current.offsetWidth,
                offsetHeight: videoRef.current.offsetHeight,
                display: window.getComputedStyle(videoRef.current).display,
                visibility: window.getComputedStyle(videoRef.current).visibility
              };
              
              console.log('비디오 요소 상태:', state);
              
              // 스트림의 트랙 상태 확인
              if (videoRef.current.srcObject) {
                const stream = videoRef.current.srcObject as MediaStream;
                const tracks = stream.getTracks().map(t => ({
                  id: t.id,
                  kind: t.kind,
                  enabled: t.enabled,
                  readyState: t.readyState,
                  muted: t.muted
                }));
                console.log('스트림 트랙 상태:', tracks);
                console.log('스트림 활성 상태:', stream.active);
                console.log('스트림 ID:', stream.id);
              }
              
              // 메타데이터 로드 후 재생 시도
              if (videoRef.current.paused) {
                videoRef.current.play().catch(err => {
                  console.error('메타데이터 로드 후 재생 실패:', err);
                  if (err.name === 'NotAllowedError') {
                    setNeedsUserInteraction(true);
                  }
                });
              }
            }
          }}
          onCanPlay={() => {
            console.log('비디오 재생 가능');
            if (videoRef.current) {
              console.log('재생 가능 시 비디오 상태:', {
                paused: videoRef.current.paused,
                readyState: videoRef.current.readyState,
                videoWidth: videoRef.current.videoWidth,
                videoHeight: videoRef.current.videoHeight
              });
            }
            // 재생 가능할 때 재생 시도
            if (videoRef.current && videoRef.current.paused) {
              videoRef.current.play().catch(err => {
                console.error('재생 가능 후 재생 실패:', err);
                if (err.name === 'NotAllowedError') {
                  setNeedsUserInteraction(true);
                }
              });
            }
          }}
          onPlaying={() => {
            console.log('비디오 재생 중');
            if (videoRef.current) {
              const state = {
                paused: videoRef.current.paused,
                readyState: videoRef.current.readyState,
                videoWidth: videoRef.current.videoWidth,
                videoHeight: videoRef.current.videoHeight,
                currentTime: videoRef.current.currentTime,
                offsetWidth: videoRef.current.offsetWidth,
                offsetHeight: videoRef.current.offsetHeight
              };
              console.log('재생 중 비디오 상태:', state);
            }
          }}
          onPlay={() => {
            console.log('✅ 비디오 재생 시작');
            setNeedsUserInteraction(false);
            if (videoRef.current) {
              console.log('재생 시작 시 비디오 상태:', {
                paused: videoRef.current.paused,
                readyState: videoRef.current.readyState,
                videoWidth: videoRef.current.videoWidth,
                videoHeight: videoRef.current.videoHeight
              });
            }
          }}
          onPause={() => {
            console.warn('⚠️ 비디오 일시정지됨');
            if (videoRef.current) {
              console.warn('일시정지 시 비디오 상태:', {
                paused: videoRef.current.paused,
                readyState: videoRef.current.readyState,
                srcObject: videoRef.current.srcObject ? '있음' : '없음'
              });
              
              // 일시정지된 경우 스트림 상태 확인
              if (videoRef.current.srcObject) {
                const stream = videoRef.current.srcObject as MediaStream;
                const tracks = stream.getTracks();
                console.warn('스트림 트랙 상태:', tracks.map(t => ({
                  id: t.id,
                  kind: t.kind,
                  readyState: t.readyState,
                  enabled: t.enabled
                })));
                
                // 트랙이 모두 ended 상태면 재연결 시도
                if (tracks.every(t => t.readyState === 'ended')) {
                  console.error('❌ 모든 트랙이 ended 상태입니다. 재연결 시도...');
                  setIsWaiting(true);
                  setHasStream(false);
                  
                  // PeerConnection에서 live 트랙 확인
                  if (peerConnection) {
                    setTimeout(() => {
                      const receivers = peerConnection.getReceivers();
                      receivers.forEach((receiver) => {
                        const track = receiver.track;
                        if (track && track.kind === 'video' && track.readyState === 'live') {
                          console.log('🔄 live 트랙 발견, 스트림 재설정');
                          const newStream = new MediaStream([track]);
                          if (videoRef.current) {
                            videoRef.current.srcObject = newStream;
                            setHasStream(true);
                            setIsWaiting(false);
                            videoRef.current.play().catch(err => {
                              console.error('비디오 재생 실패:', err);
                            });
                          }
                        }
                      });
                    }, 500);
                  }
                }
              }
            }
          }}
          onWaiting={() => {
            console.warn('⏳ 비디오 버퍼링 중...');
          }}
          onStalled={() => {
            console.error('❌ 비디오 스트림이 멈춤');
            // 스트림이 멈춘 경우 재연결 시도
            if (videoRef.current && peerConnection) {
              setTimeout(() => {
                const receivers = peerConnection.getReceivers();
                receivers.forEach((receiver) => {
                  const track = receiver.track;
                  if (track && track.kind === 'video' && track.readyState === 'live') {
                    console.log('🔄 멈춘 스트림 대신 live 트랙 발견, 재설정');
                    const newStream = new MediaStream([track]);
                    if (videoRef.current) {
                      videoRef.current.srcObject = newStream;
                      videoRef.current.play().catch(err => {
                        console.error('비디오 재생 실패:', err);
                      });
                    }
                  }
                });
              }, 1000);
            }
          }}
          onError={(e) => {
            console.error('비디오 오류:', e);
            if (videoRef.current) {
              console.error('오류 시 비디오 상태:', {
                error: videoRef.current.error,
                paused: videoRef.current.paused,
                readyState: videoRef.current.readyState
              });
            }
          }}
          onClick={() => {
            // 비디오 클릭 시 재생 시도
            if (videoRef.current && videoRef.current.paused) {
              videoRef.current.play().catch(err => {
                console.error('비디오 재생 실패:', err);
              });
            }
          }}
        />
        {(isWaiting || !hasStream) && (
          <div className="waiting-overlay">
            <div className="waiting-message">
              <div className="spinner"></div>
              <h3>화면 공유 대기 중...</h3>
              <p>다른 브라우저에서 <strong>http://localhost:5173/offer</strong>에 접속하여 화면을 공유해주세요.</p>
            </div>
          </div>
        )}
        {needsUserInteraction && hasStream && (
          <div className="play-overlay" onClick={() => {
            if (videoRef.current) {
              videoRef.current.play().then(() => {
                setNeedsUserInteraction(false);
              }).catch(err => {
                console.error('비디오 재생 실패:', err);
              });
            }
          }}>
            <div className="play-message">
              <div className="play-icon">▶</div>
              <p>재생하려면 클릭하세요</p>
            </div>
          </div>
        )}
        <div className="controls">
          <button 
            onClick={() => {
              if (videoRef.current) {
                videoRef.current.muted = !videoRef.current.muted;
                setIsMuted(videoRef.current.muted);
              }
            }} 
            className="btn-mute"
            title={isMuted ? '음소거 해제' : '음소거'}
          >
            {isMuted ? '🔇' : '🔊'}
          </button>
          <button 
            onClick={() => {
              if (videoRef.current) {
                const state = {
                  videoWidth: videoRef.current.videoWidth,
                  videoHeight: videoRef.current.videoHeight,
                  paused: videoRef.current.paused,
                  muted: videoRef.current.muted,
                  readyState: videoRef.current.readyState,
                  currentTime: videoRef.current.currentTime,
                  duration: videoRef.current.duration,
                  srcObject: videoRef.current.srcObject ? 'MediaStream' : null,
                  offsetWidth: videoRef.current.offsetWidth,
                  offsetHeight: videoRef.current.offsetHeight,
                  display: window.getComputedStyle(videoRef.current).display,
                  visibility: window.getComputedStyle(videoRef.current).visibility,
                  error: videoRef.current.error
                };
                console.log('=== 비디오 요소 상태 (수동 확인) ===');
                console.log(JSON.stringify(state, null, 2));
                if (videoRef.current.srcObject) {
                  const stream = videoRef.current.srcObject as MediaStream;
                  console.log('스트림 정보:', {
                    id: stream.id,
                    active: stream.active,
                    tracks: stream.getTracks().map(t => ({
                      id: t.id,
                      kind: t.kind,
                      enabled: t.enabled,
                      readyState: t.readyState,
                      muted: t.muted
                    }))
                  });
                }
                console.log('비디오 상태:', state);
                alert('비디오 상태가 콘솔에 출력되었습니다. 개발자 도구를 확인하세요.');
              }
            }} 
            className="btn-debug"
            title="비디오 상태 확인"
          >
            🔍
          </button>
          <button onClick={handleFullscreen} className="btn-fullscreen">
            {isFullscreen ? '전체화면 해제' : '전체화면'}
          </button>
          <button onClick={handleDisconnect} className="btn-disconnect">
            연결 해제
          </button>
        </div>
      </div>
    </div>
  );
}

export default VideoDisplay;

