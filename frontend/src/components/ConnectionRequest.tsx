import { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket } from '../utils/socket';
import './ConnectionRequest.css';

interface ConnectionRequestProps {
  onAccept: () => void;
  onReject: () => void;
}

function ConnectionRequest({ onAccept, onReject }: ConnectionRequestProps) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [showRequest, setShowRequest] = useState(false);

  useEffect(() => {
    // 전역 Socket 인스턴스 사용
    const socket = getSocket();

    const handleConnect = () => {
      console.log('서버에 연결되었습니다.');
    };

    const handleConnectionRequest = () => {
      console.log('연결 요청을 받았습니다.');
      setShowRequest(true);
    };

    const handleStartWebrtc = () => {
      console.log('WebRTC 시작');
      onAccept();
    };

    const handleError = (error: { message: string }) => {
      console.error('서버 오류:', error.message);
      // 오류가 발생해도 연결은 진행 (WebRTC 없이도 기본 연결 가능)
      if (error.message.includes('WebRTC')) {
        console.warn('WebRTC 기능이 비활성화되어 있지만 연결은 진행됩니다.');
        onAccept();
      }
    };

    const handleDisconnect = () => {
      console.log('서버 연결이 끊어졌습니다.');
    };

    socket.on('connect', handleConnect);
    socket.on('connection-request', handleConnectionRequest);
    socket.on('start-webrtc', handleStartWebrtc);
    socket.on('error', handleError);
    socket.on('disconnect', handleDisconnect);

    // 이미 연결되어 있으면 connection-request 이벤트 확인
    if (socket.connected) {
      console.log('이미 서버에 연결되어 있습니다.');
    }

    setSocket(socket);

    return () => {
      // 이벤트 리스너만 제거 (Socket 인스턴스는 유지)
      socket.off('connect', handleConnect);
      socket.off('connection-request', handleConnectionRequest);
      socket.off('start-webrtc', handleStartWebrtc);
      socket.off('error', handleError);
      socket.off('disconnect', handleDisconnect);
    };
  }, [onAccept]);

  const handleAccept = () => {
    if (socket) {
      socket.emit('connection-accept');
      setShowRequest(false);
    }
  };

  const handleReject = () => {
    if (socket) {
      socket.emit('connection-reject');
      setShowRequest(false);
      onReject();
    }
  };

  if (!showRequest) {
    return (
      <div className="connection-request">
        <div className="waiting">
          <div className="spinner"></div>
          <p>연결 대기 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="connection-request">
      <div className="request-card">
        <h2>디스플레이 연결 요청</h2>
        <p>원격 디스플레이 연결을 허용하시겠습니까?</p>
        <div className="button-group">
          <button className="btn-accept" onClick={handleAccept}>
            허용
          </button>
          <button className="btn-reject" onClick={handleReject}>
            거부
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConnectionRequest;

