# reviewer

STATUS: DONE
PHASE: 4 — 최종 통합 리뷰 완료
RESULT: **PASS** (배포 가능)
LAST_UPDATED: 2026-04-15

---

## SUMMARY

Frontend 재작업 및 Backend minor 3건 반영 후 전수 재검증 완료. FAIL 사유였던 diff 모달이 `review-diff-modal.ts` 신규 모듈로 완전 구현됨. Backend minor 3건도 모두 반영됨. onMrNew 2회 패턴이 main↔renderer 양쪽에 정확히 연결됨.

**배포 가능 판정.**

---

## Frontend 재작업 검증 결과

### 1. diff 모달 — 구현 완료 ✓
파일: `src/renderer/review/review-diff-modal.ts` (76줄, 신규)
- `role="dialog"`, `aria-modal="true"` 접근성 준수
- **XSS 방어**: 파일 경로 `escapeHtml()` 적용 (line 22, 25), diff 라인은 `textContent` 사용 (line 59)
- **ESC 닫기**: `stopPropagation()`으로 review.ts의 abort 핸들러 간섭 방지 (line 42-43)
- **X 클릭 / backdrop 클릭** 닫기 (line 45-46, backdrop 내부 클릭은 무시)
- **리스너 정리**: `close()` 호출 시 `removeEventListener('keydown', onKey)` — 누수 없음
- **포커스 관리**: 열릴 때 `.modal-close` 자동 포커스

review.ts:220-223 ESC 분기 로직 검증:
```ts
if (e.key === 'Escape' && (reviewState === 'streaming' || reviewState === 'loading')) {
  if (!document.querySelector('.modal-backdrop')) btnAbort.click();
}
```
모달 열린 상태에서는 모달 자체 keydown이 먼저 `stopPropagation` + `close()` 실행, 리뷰 abort는 호출되지 않음. 정확.

### 2. onMrNew 2회 패턴 — 양단 계약 일치 ✓
**Main → Renderer 2회 송신 지점:**
- 1회: `main.ts:108` 새 MR 감지 + 리뷰 윈도우 오픈 → `MR_NEW(Summary)`
- 2회: `ipc.ts:72` `handleReviewStart`에서 `fetchMrChanges` 후 → `MR_NEW(WithChanges)`

**Renderer 수신 분기:**
- `review.ts:23-24` `hasChanges()` 타입 가드: `'changes' in mr && Array.isArray(...)` — 런타임 안전
- `review.ts:126-133` 분기: `hasChanges(mr)` 시 `stream.setFileList(mr.changes)`, 아니면 Summary 헤더만 렌더

**완벽히 연결됨.**

### 3. stripChanges — Summary만 IPC 전달 ✓
`review.ts:169-173`:
```ts
function stripChanges(mr: MergeRequestWithChanges): MergeRequestSummary {
  const { changes: _changes, ...rest } = mr;
  void _changes;
  return rest;
}
```
`startReview` (line 163-167)에서 hasChanges 시 stripChanges 호출 → `ReviewStartPayload.mr: MergeRequestSummary` 타입 계약 준수. 2번째 MR_NEW 수신 후 [다시 리뷰] 눌러도 summary로 재전송되어 불필요한 대용량 IPC 방지.

### 4. 추가 품질 개선 발견
- `review-stream.ts:142-147` 파일별 +N/-N 추가/삭제 라인 배지, new/deleted/renamed 상태 배지 추가 — 기존 없던 UX
- `review-stream.ts:66-75` `renderWaitingForChanges()` / `renderInitialEmpty()` 분리 — 상태별 메시지 구분
- `review-markdown.ts` 88→58줄로 축소 (정규식 파싱 제거) — 복잡성 감소
- `review.ts:76-79` mrLink 리스너 render 외부 1회 등록으로 변경 — 2차 리뷰에서 지적한 once-listener 클로저 이슈 해결 (currentMr 참조)

---

## Backend Minor 3건 재검증 — 모두 반영 ✓

| # | 항목 | 상태 | 증거 |
|---|---|---|---|
| B-M1 | `recentMrs.items` 스키마 | **PASS** | store.ts:48 `items: { type: 'object' }` |
| B-M2 | `app.quit()` 후 가드 | **PASS** | main.ts:22 `process.exit(0)` (return보다 강력) |
| B-M3 | handleCommentPost 빈 token/url 가드 | **PASS** | ipc.ts:103-105 |

**보너스 발견 (지적 이상 개선):**
- main.ts:29 `HEADER_PATTERN = /(PRIVATE-TOKEN|Authorization):\s*\S+/g` 추가 마스킹 — 토큰 패턴뿐 아니라 헤더 전체 마스킹으로 2중 방어 강화

---

## 최종 체크리스트 전수 통과

### 보안 (6/6)
- [x] 토큰 로그 마스킹 (glpat-* + Authorization/PRIVATE-TOKEN 헤더 이중)
- [x] contextBridge 최소 노출
- [x] nodeIntegration: false
- [x] contextIsolation: true
- [x] sandbox: true
- [x] IPC 채널 URL 검증 (WINDOW_OPEN_MR)

### 안정성 (6/6)
- [x] GitLab API 실패 graceful
- [x] claude CLI 미설치 ENOENT 매핑
- [x] 설정 변경 재시작 (poller.restart)
- [x] 단일 인스턴스 보장 (+ process.exit 가드)
- [x] window-all-closed 종료 방지
- [x] 윈도우 중복 생성 방지

### 트레이 (5/5)
- [x] 4 TrayState 매핑
- [x] NEW_MR 깜빡임 800ms + destroy 정리
- [x] ACTIVE↔MUTED 토글
- [x] 최근 MR 최대 5개
- [x] 앱 종료 시 tray.destroy()

### 코드 품질 (5/5)
- [x] any 0건 (backend + frontend)
- [x] console.* 0건
- [x] 하드코딩 없음 (marked CDN URL만 예외, minor)
- [x] 전 파일 300줄 미만
- [x] 설계와 일치

### 중복 알림 방지 (3/3)
- [x] seenMrIds electron-store
- [x] 재시작 후 중복 방지
- [x] 200개 제한

### Frontend UI/UX (7/7)
- [x] 5-state 상태 머신 (idle/loading/streaming/done/error)
- [x] 스트리밍 중 버튼 비활성화/숨김
- [x] 에러 상태 UI 표시
- [x] 설정 미완료 자동 오픈
- [x] 연결 테스트 (SETTINGS_TEST) + userId 자동입력
- [x] diff 모달 ESC/X/backdrop 닫기
- [x] 접근성 (role, aria, 키보드, prefers-reduced-motion)

### Frontend IPC 계약 (5/5)
- [x] `window.electronAPI`만 사용 (require/process 없음)
- [x] hasChanges 타입 가드 (`'changes' in mr && Array.isArray(...)`)
- [x] onMrNew 2회 패턴 (Summary → WithChanges)
- [x] stripChanges로 Summary만 IPC 전송
- [x] REVIEW_CHUNK.chunk plain text 계약

---

## 잔여 Minor (차기 개선 — 배포 후 고려)

배포 차단 아님. 모두 defense-in-depth 또는 운영 환경 고려 사항.

1. **[FE]** `marked.parse` → `innerHTML` 직접 삽입 (review-stream.ts:87) — CSP로 대부분 방어되나 DOMPurify 추가로 완전 방어 권장.
2. **[FE]** `onXxx` unsubscribe 반환값 무시 — 윈도우 close 시 자연 정리되어 실질 누수 없음. `beforeunload`에서 cleanup 권장.
3. **[FE]** `review/index.html:13` marked CDN 하드코딩 — 오프라인 환경 고려 시 npm 번들.
4. **[FE]** `testConnection`이 saveSettings 선저장 흐름 (settings.ts:138) — 사용자 기대와 다를 여지. 별도 임시 테스트 IPC 또는 UI 문구 강화.
5. **[FE]** `openDiffModal` 이중 클릭 방어 없음 — 동시 2모달 가능성 미미하나 가드 권장.
6. **[BE]** poller restart 시 AbortController로 진행 중 요청 취소 — seenIds Set 공유 구조상 실질 영향 미미.
7. **[BE]** `app.on('second-instance')` 리스너 미등록 — 두 번째 인스턴스 실행 시 기존 트레이 플래시/설정 창 팝업 권장 (사용자 피드백 UX).

---

## 최종 결론

**Backend: PASS** (1차 PASS 유지 + minor 3건 반영)
**Frontend: PASS** (diff 모달 구현 완료, FAIL 사유 해소)
**통합: PASS — 배포 가능**

리뷰 완료. 추가 재작업 불필요.
