# WebRTC 스트리밍 시스템

macOS 시스템의 화면을 WebRTC를 통해 웹 브라우저로 실시간 스트리밍하여 원격 디스플레이로 활용하는 시스템입니다.

## 기술 스택

- **백엔드**: NestJS (pnpm 패키지 매니저)
- **프론트엔드**: React + TypeScript + Vite
- **WebRTC**: Socket.io를 통한 시그널링, `@koush/wrtc`를 사용한 서버 측 WebRTC
- **화면 캡처**: `fluent-ffmpeg`를 통한 화면 캡처
- **네트워크**: ngrok 지원 (원격 접속용)

## 프로젝트 구조

```
web-rtc/
├── backend/          # NestJS 서버 (포트 3000)
│   ├── src/
│   │   ├── gateway/  # WebSocket 게이트웨이 (시그널링)
│   │   │   └── signaling.gateway.ts
│   │   ├── webrtc/   # WebRTC 핸들러
│   │   │   └── webrtc.service.ts
│   │   ├── capture/  # 화면 캡처 모듈
│   │   │   └── capture.service.ts
│   │   ├── app.module.ts
│   │   └── main.ts
│   └── package.json
├── frontend/         # React 웹 앱 (포트 5173)
│   ├── src/
│   │   ├── components/
│   │   │   ├── ConnectionRequest.tsx  # 연결 요청 UI
│   │   │   ├── VideoDisplay.tsx       # 스트리밍 화면 표시 (수신)
│   │   │   └── ScreenShare.tsx       # 화면 공유 (송신)
│   │   ├── utils/
│   │   │   └── socket.ts              # Socket.io 클라이언트
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── package.json
└── package.json      # 루트 워크스페이스 (pnpm workspace)
```

## 설치 및 실행

### 사전 요구사항

- Node.js 18 이상
- pnpm 패키지 매니저
- macOS (화면 캡처 기능 사용)
- ffmpeg (화면 캡처용)

### 설치

```bash
# 루트 디렉토리에서 모든 패키지 설치
pnpm install
```

### 실행

```bash
# 백엔드와 프론트엔드를 동시에 실행 (concurrently 사용)
pnpm dev

# 또는 개별 실행
pnpm dev:backend   # 백엔드만 실행 (포트 3000, 0.0.0.0에 바인딩)
pnpm dev:frontend  # 프론트엔드만 실행 (포트 5173)

# 병렬 실행 (ngrok 없이)
pnpm dev:no-ngrok
```

### 빌드 및 프로덕션 실행

```bash
# 프론트엔드 빌드
pnpm build:frontend

# 프론트엔드 프로덕션 서버 실행
pnpm start:frontend        # 기본 포트
pnpm start:frontend:1      # 포트 5173
pnpm start:frontend:2      # 포트 5200
```

### 원격 접속 (ngrok)

```bash
# ngrok 터널 생성 (포트 5173)
pnpm ngrok
```

## 사용 방법

1. **백엔드와 프론트엔드 실행**

   ```bash
   pnpm dev
   ```

2. **웹 브라우저 접속**

   - 로컬: `http://localhost:5173`
   - 네트워크: `http://<로컬IP>:5173`
   - 원격 (ngrok 사용 시): ngrok에서 제공하는 URL

3. **라우트**

   - `/`: VideoDisplay 컴포넌트 (스트리밍 화면 수신)
   - `/offer`: ScreenShare 컴포넌트 (화면 공유 송신)

4. **연결 설정**
   - 연결 요청이 표시되면 "허용" 버튼을 클릭
   - WebRTC 연결이 설정되면 macOS 화면이 스트리밍됨
   - 전체화면 모드로 전환하여 모니터처럼 사용 가능

## 주요 기능

- **연결 요청**: 웹 브라우저에서 접속 시 연결 요청 UI 표시
- **허용/거부**: 사용자가 웹 브라우저에서 허용 버튼 클릭
- **화면 캡처**: macOS 화면을 실시간으로 캡처 (ffmpeg 사용)
- **WebRTC 스트리밍**: 캡처된 화면을 WebRTC로 스트리밍
- **원격 디스플레이**: 웹 브라우저에서 스트리밍된 화면을 모니터처럼 표시
- **네트워크 접속**: 0.0.0.0 바인딩으로 로컬 네트워크에서 접속 가능
- **CORS 지원**: 개발 환경에서 모든 origin 허용

## 네트워크 설정

- **백엔드**: `0.0.0.0:3000`에 바인딩되어 모든 네트워크 인터페이스에서 접근 가능
- **프론트엔드**: 기본적으로 `localhost:5173`에서 실행
- **CORS**: 개발 환경에서는 모든 origin 허용 (다른 와이파이에서 접근 가능)

## 주의사항

- macOS에서 화면 캡처 권한이 필요할 수 있습니다.
- WebRTC 연결을 위해서는 STUN 서버가 필요하며, 현재는 Google의 공개 STUN 서버를 사용합니다.
- `@koush/wrtc` 패키지는 네이티브 모듈이므로 빌드 시 추가 시간이 필요할 수 있습니다.
- ngrok을 사용할 경우 무료 플랜의 제한사항을 확인하세요.

## 향후 개선 사항

- [ ] 실제 macOS 화면 캡처 구현 (ScreenCaptureKit 또는 ffmpeg)
- [ ] WebRTC 서버 측 PeerConnection 구현
- [ ] 다중 클라이언트 지원
- [ ] 화면 선택 기능 (전체 화면 또는 특정 영역)
- [ ] 오디오 스트리밍 지원
- [ ] 보안 강화 (인증, 암호화)
- [ ] 성능 최적화 (프레임 레이트, 해상도 조절)
# web-rtc
