import { io, Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;

// 백엔드 서버 URL을 동적으로 생성
const getBackendUrl = (): string => {
  // 환경 변수가 있으면 사용
  if (import.meta.env?.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL;
  }
  
  // 현재 페이지의 호스트를 사용하여 백엔드 URL 생성
  // 같은 호스트의 3000 포트로 연결
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  return `${protocol}//${hostname}:3000`;
};

export const getSocket = (): Socket => {
  if (!socketInstance) {
    const backendUrl = getBackendUrl();
    console.log('백엔드 서버 연결:', backendUrl);
    socketInstance = io(backendUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      timeout: 20000,
    });

    // 연결 이벤트 리스너
    socketInstance.on('connect', () => {
      console.log('✅ 소켓 연결 성공:', socketInstance?.id);
    });

    socketInstance.on('connect_error', (error) => {
      console.error('❌ 소켓 연결 오류:', error.message);
      console.log('백엔드 서버 URL:', backendUrl);
      console.log('백엔드 서버가 실행 중인지 확인하세요: http://localhost:3000');
    });

    socketInstance.on('disconnect', (reason) => {
      console.warn('⚠️ 소켓 연결 해제:', reason);
    });

    socketInstance.on('reconnect', (attemptNumber) => {
      console.log('🔄 소켓 재연결 성공 (시도 횟수:', attemptNumber, ')');
    });

    socketInstance.on('reconnect_attempt', (attemptNumber) => {
      console.log('🔄 소켓 재연결 시도 중... (시도 횟수:', attemptNumber, ')');
    });

    socketInstance.on('reconnect_error', (error) => {
      console.error('❌ 소켓 재연결 오류:', error.message);
    });

    socketInstance.on('reconnect_failed', () => {
      console.error('❌ 소켓 재연결 실패: 최대 재시도 횟수 초과');
    });
  }
  return socketInstance;
};

export const disconnectSocket = () => {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
};

