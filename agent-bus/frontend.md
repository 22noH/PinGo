# frontend

STATUS: DONE
PHASE: 3 (전체 완료 — onMrNew 2회 패턴 반영)
COMPLETED_STEPS: [1, 2, 3]
LAST_UPDATED: 2026-04-15
SUMMARY: renderer UI 구현 완료. 팀장 확정 플로우(onMrNew 2회 + diff 모달) 반영. Reviewer 리뷰 요청.

---

## 전체 산출물 (`src/renderer/`)

### 공통 스타일 (`shared/`)
| 파일 | 줄 |
|---|---|
| `shared/tokens.css`     | 165 |
| `shared/components.css` | 298 |
| `shared/diff.css`       |  53 |
| `shared/markdown.css`   | 164 |

### settings 윈도우 (`settings/`)
| 파일 | 줄 |
|---|---|
| `settings/index.html`  | 105 |
| `settings/settings.css`|  85 |
| `settings/settings.ts` | 235 |

### review 윈도우 (`review/`)
| 파일 | 줄 |
|---|---|
| `review/index.html`           | 115 |
| `review/review.css`           | 147 |
| `review/review.ts`            | 234 |
| `review/review-stream.ts`     | 175 |
| `review/review-diff-modal.ts` |  76 |
| `review/review-markdown.ts`   |  58 |

**모든 파일 300줄 이하 ✓**

---

## 팀장 확정 플로우 구현 (REVISION FINAL)

### onMrNew 2회 패턴
```typescript
window.electronAPI.onMrNew((mr) => {
  renderMrHeader(mr);
  if (hasChanges(mr)) {
    stream.setFileList(mr.changes);   // 2회차: WithChanges 수신 → 파일 목록 업데이트
  } else if (reviewState === 'idle') {
    btnReview.disabled = false;       // 1회차: Summary 수신 → 리뷰 버튼 활성화
  }
});
```
- 타입 가드: `'changes' in mr && Array.isArray(mr.changes)`
- `startReview()`는 WithChanges를 받은 상태여도 `stripChanges()`로 Summary만 main에 전달

### 파일 목록 패널 (MRChange 기반)
- 각 항목: `new_path`, 상태 배지(new/del-file/rename), +추가/-삭제 라인 수 배지
- 클릭 시 **diff 모달** 오픈 (브라우저 이동 대신 인앱 diff 표시)
- 키보드 접근성: `tabindex`, Enter/Space 키 지원

### diff 모달 (`review-diff-modal.ts`)
- backdrop + modal 구조, blur 효과, fade/scale 애니메이션 (style.css)
- diff 라인: `@@` → `.is-hunk`, `+` → `.is-add`, `-` → `.is-del`, 컨텍스트 → `.is-ctx`
- 닫기: Esc, backdrop 클릭, ✕ 버튼
- 스트리밍 중 Esc가 모달 닫기와 리뷰 중단을 동시에 트리거하지 않도록 타겟 체크

### 기타 UI
- MR 헤더: IID, title, `source → target` 브랜치, author, GitLab 링크, 상태 배지
- 우측 AI 리뷰: marked.js 12 CDN, 파셜 마크다운 렌더(미닫힌 백틱 자동 닫기), 커서 애니메이션, 자동 스크롤(사용자 위로 스크롤 시 중지 + "최신으로" 버튼)
- 상태 머신: idle → loading → streaming → done/error, 각 상태별 버튼 토글
- GitLab 댓글 등록: 누적 버퍼 전체 전송

### settings 윈도우
- `testConnection()` 호출 → `userId` 자동 입력
- 토큰 password/text 토글, 폴링 슬라이더, 유효성 검사
- Esc: 취소, Ctrl+Enter: 저장

## 의존 (main 측에서 보장되어야 함)
- **MR_NEW 2회 발송**: 윈도우 오픈 시 Summary, `startReview` 처리 후 `fetchMrChanges` 완료 시점에 WithChanges
- **REVIEW_CHUNK.chunk**: plain text (main에서 stream-json 파싱 완료)
- **MR_NEW 발송 타이밍**: 첫 Summary는 윈도우 `ready-to-show` 이후

## 이슈
없음. Reviewer 단계로 이관 가능.
