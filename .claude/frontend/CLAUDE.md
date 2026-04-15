# Frontend Agent

## 역할
renderer/ UI 전담. Claude Desktop 스타일 다크테마.
Backend preload.ts 완료 후 settings/review 윈도우 구현.

## 시작 시 행동
1. C:\Users\User\Desktop\Src\pingo\CLAUDE.md 정독
2. ~/.claude/teams/pingo/config.json 읽어서 팀원 파악
3. agent-bus/architect.md 정독 (IPC 채널 + contextBridge API 파악)
4. Orchestrator에게 합류 인사 전달
5. style.css는 Backend와 독립적이므로 **선행 착수 가능** (Orchestrator 허가 받아서)
6. Backend preload.ts DONE 신호 오면 settings/review 윈도우 착수

## 디자인 시스템
```css
--bg-primary:   #1a1b2e;
--bg-surface:   #242538;
--bg-elevated:  #2d2e47;
--accent-blue:  #89b4fa;
--accent-purple:#cba6f7;
--accent-green: #a6e3a1;
--accent-red:   #f38ba8;
--accent-yellow:#f9e2af;
--border:       1px solid rgba(255,255,255,0.08);
--shadow:       0 4px 24px rgba(0,0,0,0.4);
```
폰트: JetBrains Mono (코드), Inter (UI)

## 구현 순서

### Step 1. 공통 스타일 (src/renderer/shared/)
파일 300줄 제한으로 분할:
- tokens.css — CSS 변수, 리셋, 스크롤바, 유틸
- components.css — 버튼/입력/슬라이더/카드/배지/스피너/모달
- diff.css — unified diff 뷰어 (add/del/hunk 색상)
- markdown.css — 마크다운 + 스트리밍 커서 keyframes

### Step 2. 설정 윈도우 (src/renderer/settings/)
- index.html, settings.css, settings.ts
- window.electronAPI.loadSettings() 로 기존 값 로드
- 토큰 필드: type=password, 눈 아이콘 토글
- 연결 테스트: window.electronAPI.testConnection() → userId 자동입력
- 폴링 슬라이더: 10초~5분
- 유효성 검사 후 window.electronAPI.saveSettings()
- Esc: 취소, Ctrl+Enter: 저장

### Step 3. 리뷰 윈도우 (src/renderer/review/)
파일 300줄 제한으로 분할:
- index.html, review.css
- review.ts — 메인 로직, 상태 머신
- review-stream.ts — 파일 목록 + 스트리밍 관리
- review-diff-modal.ts — 인앱 diff 모달
- review-markdown.ts — marked.js 파셜 렌더링

#### onMrNew 2회 패턴 (핵심)
```typescript
window.electronAPI.onMrNew((mr) => {
  renderMrHeader(mr);
  if ('changes' in mr) {
    // 2회차: MergeRequestWithChanges → 파일 목록 업데이트
    stream.setFileList(mr.changes);
  }
  // 1회차: MergeRequestSummary → 헤더만 표시
});
```

#### startReview 시 Summary만 전달
```typescript
// changes 제거 후 Summary만 전달 (대용량 payload 방지)
const { changes, ...summary } = currentMr as MergeRequestWithChanges;
window.electronAPI.startReview({ mr: summary });
```

#### diff 모달 (review-diff-modal.ts)
- 파일 클릭 시 인앱 모달 오픈 (브라우저 열기 아님)
- unified diff 라인별 색상 (add: 초록, del: 빨강, hunk: 파랑)
- role="dialog", aria-modal="true" 접근성
- ESC/backdrop/X 버튼 닫기
- 스트리밍 중 ESC: 모달 열려있으면 닫기만, 없으면 리뷰 중단

#### 상태 머신
idle → loading → streaming → done/error
- streaming 중: [리뷰 시작] 비활성화
- done: [다시 리뷰] 버튼 표시, [댓글 등록] 활성화
- error: 에러 메시지 + [다시 시도] 버튼

## 보안
- XSS: textContent 사용, escapeHtml 유틸, innerHTML은 DOMPurify 필터 후만
- CSP 헤더 설정 (settings/review 양쪽)

## 금지사항
- any 타입 금지
- console.log 금지
- 파일 300줄 초과 금지 → 파일 분리
- window.electronAPI 외 IPC 직접 접근 금지

## 보고 형식 (agent-bus/frontend.md)
```
STATUS: IN_PROGRESS
COMPLETED_STEPS: [1, 2]
CURRENT_STEP: 3
```
전체 완료 시:
```
STATUS: DONE
COMPLETED_STEPS: [1, 2, 3]
SUMMARY: UI 구현 완료.
```
