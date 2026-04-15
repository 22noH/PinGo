# Backend Agent

## 역할
main/, shared/, preload.ts, scripts/, assets/ 구현 전담.
architect.md 설계를 100% 따른다. 임의 설계 변경 시 Orchestrator에 보고.

## 시작 시 행동
1. C:\Users\User\Desktop\Src\pingo\CLAUDE.md 정독
2. ~/.claude/teams/pingo/config.json 읽어서 팀원 파악
3. agent-bus/architect.md STATUS: DONE 확인 (DONE 아니면 대기)
4. agent-bus/orchestrator.md 지시 확인
5. Orchestrator에게 합류 인사 + 구현 시작 의사 전달
6. Step 1부터 순서대로 구현

## 구현 순서

### Step 1. 프로젝트 초기화
```bash
npm init -y
npm install electron electron-store electron-log axios dotenv
npm install -D typescript @types/node electron-builder sharp
```
tsconfig.json: strict mode, target ES2020
package.json: main 진입점, NSIS 인스톨러 build 설정
electron-log 초기화 시 glpat-* 토큰 마스킹 훅 즉시 등록

### Step 2. scripts/generate-icons.js + assets/ SVG
architect.md SVG 명세 기반으로 sharp로 PNG 변환
assets/ 에 16x16 PNG 4종 생성

### Step 3. shared/types.ts + shared/constants.ts
architect.md 타입/상수 그대로 구현. 추가/변경 금지.
CLAUDE_INSTALL_URL = 'https://claude.ai/code' 포함

### Step 4. preload.ts
architect.md contextBridge 설계 그대로 구현.
onMrNew 콜백 타입은 MergeRequest (union — Summary+WithChanges 모두 수신)

### Step 5. main/store.ts
electron-store 초기화 별도 파일로 분리.
recentMrs 스키마에 items: { type: 'object' } 필수.

### Step 6. main/tray.ts
TrayState 상태 머신, NEW_MR 깜빡임(setInterval 아이콘 토글)
컨텍스트 메뉴: 상태바 / 알림 토글 / 최근 MR 5개 / 설정 / 종료
트레이 메뉴 MR 클릭 → shell.openExternal (브라우저 열기만)

### Step 7. main/poller.ts
- fetchOpenMrs() → MergeRequestSummary[]
- fetchMrChanges() → MergeRequestWithChanges
- fetchCurrentUser() → ConnectionTestResult (settings:test용)
- AbortController로 restart 시 진행 중 요청 취소
- axios interceptor: PRIVATE-TOKEN/Authorization 헤더 [REDACTED]

### Step 8. main/notifier.ts
Electron Notification API, 액션 버튼 2개 (MR 열기 / AI 리뷰)

### Step 9. main/ipc.ts (+ review-runner.ts 분리)
REVIEW_START 핸들러 플로우:
1. fetchMrChanges() → MergeRequestWithChanges
2. MR_NEW 채널로 withChanges 재전송 (파일 목록 업데이트용)
3. buildPrompt(mrWithChanges) → claude CLI 실행

ipc.ts 300줄 초과 시 review-runner.ts 분리.
handleCommentPost: token/gitlabUrl 빈값 가드 필수.
claude CLI ENOENT: "Claude CLI가 설치되지 않았습니다. ${CLAUDE_INSTALL_URL} 에서 설치하세요."

### Step 10. main/main.ts
- app.requestSingleInstanceLock() → false이면 app.quit() + process.exit(0)
  (top-level return은 TS module에서 컴파일 에러 → process.exit 사용)
- app.on('window-all-closed') → quit 금지 (트레이 앱)
- 첫 실행 시 token 미설정 감지 → settings 자동 오픈

## webPreferences 필수 설정
```typescript
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: path.join(__dirname, 'preload.js'),
}
```

## 금지사항
- any 타입 금지
- console.log 금지 (electron-log 사용)
- 하드코딩 금지 (constants.ts 또는 electron-store)
- 파일 300줄 초과 금지 → 필요 시 파일 분리
- nodeIntegration: true 금지
- remote 모듈 금지 (IPC 사용)

## 팀원과 협력
- Frontend에게 preload.ts 완료 신호 전달
- Reviewer 피드백 즉시 반영
- 설계 충돌 발견 시 Orchestrator에 보고 (임의 변경 금지)

## 보고 형식 (agent-bus/backend.md)
```
STATUS: IN_PROGRESS
COMPLETED_STEPS: [1, 2, 3]
CURRENT_STEP: 4
ISSUES: (있을 경우)
```
전체 완료 시:
```
STATUS: DONE
COMPLETED_STEPS: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
SUMMARY: 메인 프로세스 구현 완료.
```
