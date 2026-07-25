# Pingo

> GitLab/GitHub MR·PR과 Jira 이슈를 백그라운드에서 감지해 Windows 트레이로 알리고, 클릭 한 번으로 LLM 코드 리뷰를 스트리밍 받은 뒤 사람이 검토·승인해 원격 저장소에 게시하는 Electron 데스크톱 에이전트.

## 해결한 문제

코드 리뷰 워크플로에는 두 가지 마찰이 있다.

1. **놓치는 리뷰 요청** — MR/PR이 올라오거나 리뷰어로 지정돼도 알아채는 데 시간이 걸린다. 브라우저 탭을 계속 열어두거나 메일/메신저 알림에 의존해야 한다.
2. **리뷰 자체의 시간 비용** — 변경 파일을 일일이 열어 diff를 읽고, 버그·보안·성능 관점을 점검하는 데 인지 부하가 크다.

Pingo는 이 둘을 하나의 데스크톱 에이전트로 묶었다. 트레이에 상주하며 원격 저장소를 폴링해 변경을 감지하고(알림), 감지된 MR/PR에 대해 LLM이 1차 리뷰 초안을 작성한다(리뷰 자동화). 단, **LLM 결과를 그대로 원격에 올리지 않는다.** 사람이 초안을 읽고 수정한 뒤 직접 게시 버튼을 눌러야 댓글이 등록되는 human-in-the-loop 게이트를 둬, "AI가 멋대로 코멘트를 다는" 위험을 구조적으로 차단했다.

## 아키텍처

Electron의 3-프로세스 모델(main / preload / renderer)을 따르되, **외부 연동을 전부 인터페이스 뒤로 추상화**한 것이 핵심 설계다. LLM은 5개 구현체(Claude CLI, Codex CLI, Anthropic API, OpenAI API, Ollama)를 `AIProvider` 하나로, Git 호스트는 GitLab·GitHub를 `GitProvider` 하나로 묶어, 사용자가 설정에서 고른 조합이 런타임에 팩토리로 주입된다.

```mermaid
flowchart TB
    subgraph Renderer["Renderer (sandbox, nodeIntegration:false)"]
        RV["리뷰 윈도우<br/>스트리밍 렌더 · diff 모달 · 편집 · 게시 버튼"]
        SET["설정 윈도우<br/>Git/AI/Jira 연결"]
    end
    PRELOAD["preload.ts<br/>contextBridge — 화이트리스트 IPC API만 노출"]
    subgraph Main["Main Process"]
        POLL["poller.ts<br/>멀티 provider 병렬 폴링 · seen-ID 중복방지"]
        TRAY["tray.ts<br/>상태머신 ACTIVE/MUTED/NEW_MR/ERROR"]
        NOTI["notifier.ts<br/>Windows 토스트"]
        RUN["review-runner.ts<br/>프롬프트 빌드 + 스트리밍 실행"]
        IPC["ipc.ts<br/>핸들러 · 게시 시 휴먼 게이트"]
    end
    subgraph AIP["AIProvider (factory)"]
        CLI["Claude CLI · Codex CLI<br/>Anthropic · OpenAI · Ollama"]
    end
    subgraph GP["GitProvider (factory)"]
        GIT["GitLab · GitHub REST"]
    end

    RV <-->|"ipcRenderer ↔ ipcMain"| PRELOAD <--> IPC
    SET <--> PRELOAD
    POLL -->|새 이벤트| NOTI
    POLL --> TRAY
    POLL -->|REST 폴링| GP
    IPC --> RUN -->|stream-json / SSE| AIP
    IPC -->|게시(사용자 승인 후)| GP
```

**핵심 설계 결정과 '왜'**

- **main/preload/renderer 분리 + contextBridge 단일 게이트웨이** — renderer는 `sandbox:true`, `nodeIntegration:false`, `contextIsolation:true`로 잠그고, 사용 가능한 모든 작업을 `preload.ts`가 정의한 `ElectronAPI` 화이트리스트로만 노출했다. renderer에 Node·시스템 권한을 주지 않으면서도 LLM 호출·REST 게시 같은 특권 작업을 안전하게 위임하기 위함. (`src/preload.ts`, `src/main/windows.ts`)
- **`AIProvider` / `GitProvider` 인터페이스 추상화** — LLM 제공자와 Git 호스트를 교체 가능한 플러그인으로 설계했다. 사내망 보안상 외부 API를 못 쓰면 로컬 Ollama나 Claude CLI로, GitLab 대신 GitHub로 코드 변경 없이 전환된다. 팩토리에서 `never` 타입 exhaustiveness 체크로 새 제공자 누락을 컴파일 타임에 잡는다. (`src/main/providers/ai/ai-provider.ts`)
- **폴링당 단일 in-flight + AbortController** — 폴링 주기보다 응답이 느려도 틱이 중첩되지 않게 `inFlight` 가드를 두고, 설정 변경/중지 시 진행 중 요청을 `abort()`로 취소한다. 네트워크 일시 장애 시 빈 데이터로 목록을 덮어쓰지 않도록 `Promise.allSettled` 결과 중 하나라도 성공하면 그 결과만 반영한다. (`src/main/poller.ts`)

## 기술 스택

| 항목 | 기술 | 근거 |
|------|------|------|
| 런타임/프레임워크 | Electron 32 | `package.json`, `src/main/main.ts` |
| 언어 | TypeScript 5 (strict, `any` 금지) | `tsconfig`, 코드 전반 |
| LLM 통합 | Claude Code CLI (`claude -p --output-format stream-json`), `@anthropic-ai/sdk`, `openai` SDK, Codex CLI, Ollama HTTP | `src/main/providers/ai/*` |
| Git 연동 | GitLab REST v4 · GitHub REST (axios + PAT) | `src/main/providers/git/*` |
| 이슈 트래커 | Jira (폴링 + 로컬 webhook 서버, HMAC 토큰) | `src/main/jira-poller.ts`, `jira-webhook-server.ts` |
| 프로세스 통신 | Electron IPC + contextBridge | `src/preload.ts`, `src/main/ipc*.ts` |
| 알림 | Electron Notification API (Windows 토스트) | `src/main/notifier.ts` |
| 설정/상태 저장 | electron-store, 비밀값은 `.env`(dotenv) | `src/main/store.ts` |
| 로깅 | electron-log (`console.log` 금지) | 코드 전반 |
| 빌드 | esbuild(renderer 번들), electron-builder(NSIS) | `scripts/`, `package.json` |

## 주요 구현

### 1. Claude CLI 스트리밍 오케스트레이션

AI 리뷰는 Claude Code CLI를 **자식 프로세스로 spawn**해서 받는다. `--output-format stream-json --verbose`로 NDJSON 스트림을 받고, 프롬프트는 인자가 아니라 **stdin**으로 흘려보낸다(긴 프롬프트의 인자 길이 제한·이스케이프 문제 회피).

```ts
// src/main/providers/ai/claude-cli.ts
const args = ['-p', '--output-format', 'stream-json', '--verbose'];
if (model)  args.push('--model', model);
if (effort) args.push('--effort', effort);
const proc = spawn(execPath, args, { stdio: ['pipe','pipe','pipe'], shell: useShell });
// stdout 라인 버퍼링 → JSON 파싱 → assistant content 블록의 text만 onChunk()
proc.stdin.write(prompt, 'utf-8'); proc.stdin.end();
```

- **라인 버퍼링 파서** — stdout 청크 경계가 JSON 라인 경계와 다르므로 `\n` 기준으로 누적·분할하고, 마지막 미완성 라인은 다음 청크까지 보관한다. `assistant` 이벤트의 content 블록, 레거시 `text` 이벤트, 최종 `result` 이벤트(청크를 한 번도 못 받았을 때의 폴백), `error` 이벤트를 모두 분기 처리한다.
- **계약 보장** — `streamReview(prompt, onChunk, onDone, onError)`는 콜백 셋 중 정확히 하나만 종결 호출되도록 설계했고(`AIProvider` 인터페이스), 사용자가 [중단]을 누르면 `SIGTERM`으로 프로세스를 종료한다.
- **렌더 측**은 청크를 IPC로 받아 마크다운으로 점진 렌더링하고, 사용자가 위로 스크롤하지 않은 동안에만 자동 스크롤하며 스트리밍 커서를 표시한다. (`src/renderer/review/review-stream.ts`)
- 동일 인터페이스 위에서 Anthropic/OpenAI는 공식 SDK의 `messages.stream()` 이벤트로, Ollama는 로컬 HTTP로 같은 콜백 규약을 구현한다 — **제품 코드는 어떤 LLM인지 모른 채 동작한다.**

### 2. GitLab/GitHub 폴링과 중복 방지

`GitProvider`로 추상화된 멀티 호스트를 **병렬 폴링**한다(기본 30초, 최소 10초 클램프). 토큰이 접근 가능한 모든 open MR/PR을 가져와 다음을 감지한다.

- **신규 항목** — `seen.items` 집합으로 한 번 알린 MR/PR을 기억해 재알림 방지.
- **리뷰어 지정** — 기존 항목인데 내가 리뷰어로 추가되면 별도 이벤트. 리뷰어에서 빠지면 집합에서 제거해 재지정 시 다시 알림.
- **새 댓글/멘션** — 항목별 `lastSeenNoteAt`(ISO 타임스탬프)를 저장해, `updatedAt`이 그보다 최신인 항목만 discussions를 조회한다(불필요한 API 호출 절감). 첫 조회는 시드만 하고 기존 댓글을 새 댓글로 오인하지 않는다. 내가 쓴 댓글·시스템 노트는 제외하고, `@username` 멘션은 단어 경계까지 고려해 정규식으로 판정한다.
- 같은 MR이 author·reviewer 양쪽 쿼리에서 중복돼 와도 id 기준으로 dedup한다. (`src/main/poller.ts`, `src/main/providers/git/gitlab-provider.ts`)

### 3. 트레이 상태머신

트레이 아이콘이 곧 시스템 상태다. `ACTIVE`(폴링 중) / `MUTED`(알림 끔, 폴링은 유지) / `NEW_MR`(새 항목, 아이콘 깜빡임) / `ERROR`(연결 실패) 네 상태를 전이시키며, 우클릭 메뉴에 연결 헬스("GitLab ✓ · GitHub ✗")와 마지막 확인 시각, 최근 MR/PR 목록(각 항목에서 바로 [AI 리뷰]/[브라우저 열기])을 보여준다. (`src/main/tray.ts`)

### 4. Human-in-the-loop 게이트 (검증됨)

> **확인 결과: AI 리뷰 결과는 자동 게시되지 않는다.** 스트리밍이 끝나면 결과는 리뷰 윈도우에만 표시되고, 사용자는 (선택적으로 텍스트를 편집한 뒤) **[GitLab 댓글 등록] 버튼을 눌러야** 비로소 게시된다.

게시 경로는 `버튼 클릭 → postCommentAction → preload(contextBridge) → ipcMain(COMMENT_POST) → GitProvider.postComment → POST /discussions`로, 버튼 이벤트 없이는 어떤 코드 경로로도 댓글이 등록되지 않는다. 게시에 성공해야 인터랙션이 'commented'로 기록된다. (`src/renderer/review/review.ts`의 `btnComment` 핸들러, `review-comment.ts`, `src/main/ipc.ts`의 `handleCommentPost`)

### 5. Electron 보안 (검증됨)

- 모든 윈도우가 `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`. renderer는 `preload.ts`가 노출한 API 외에는 어떤 Node·Electron 기능에도 접근 불가. (`src/main/windows.ts`, `src/preload.ts`)
- `shell.openExternal`은 `^https?://` 정규식으로 검증한 URL만 연다(임의 스킴·`file://` 차단). (`src/main/ipc.ts`)
- 로그에 토큰이 새지 않도록 axios 인터셉터에서 `PRIVATE-TOKEN`·`Authorization` 헤더를 마스킹한다. (`gitlab-provider.ts`)
- 토큰 보관: `.env`(dotenv) 및 electron-store. **단, electron-store에는 평문 저장이며, 코드 주석에 OS 키체인(keytar) 연동이 TODO로 명시돼 있다.** (`src/main/store.ts`) → 아래 회고/주의 참고.

## 결과 / 비즈니스 효과

데모 가능한 동작 기능(코드로 확인됨):

- 멀티 호스트(GitLab+GitHub) + Jira를 한 트레이에서 통합 감지 → 알림.
- 5종 LLM(Claude CLI/Codex CLI/Anthropic/OpenAI/Ollama) 중 택1로 코드 리뷰 스트리밍.
- 변경 파일별 인앱 diff 모달, 리뷰 결과 마크다운 렌더링·편집·캐시(최대 200건/200KB).
- 사람이 승인해야만 원격 저장소에 게시되는 안전 게이트.
- Windows NSIS 인스톨러로 배포 가능(`npm run dist`).

비즈니스 가치: 리뷰 요청 인지→1차 리뷰 작성까지의 리드타임을 데스크톱 알림 + LLM 초안으로 단축하면서, 휴먼 게이트로 품질·책임 소재를 사람이 통제한다.

> 정량 효과(리뷰 소요시간 절감률, 놓친 MR 감소 등)는 사용 로그가 없어 **[지표 확인 필요]** — 실측 전이므로 수치는 기재하지 않음.

## 회고

**기술적으로 배운 점.** 이 프로젝트의 무게중심은 "동작하는 LLM 통합 제품"이었다. LLM을 단순 호출이 아니라 **프로덕트 워크플로의 한 단계**로 끼워 넣으려면, (1) 제공자를 인터페이스로 추상화해 환경(사내망/외부망)에 맞게 교체 가능하게 만들고, (2) 스트리밍 출력을 안정적으로 파싱·렌더링하며(라인 버퍼링·콜백 단일 종결 계약·중단 처리), (3) 무엇보다 AI 출력과 외부 시스템(원격 저장소) 사이에 **명시적 휴먼 게이트**를 둬야 한다는 것을 코드로 익혔다. CLI를 자식 프로세스로 띄워 stdin/stdout NDJSON으로 다루는 방식은 API 키 없이도 LLM을 제품에 붙일 수 있는 실용적 통합 패턴이었다.

**정직한 한계.** 토큰이 electron-store에 평문 저장되는 부분은 미완(코드에 keytar TODO 명시)이며, 정량 지표는 아직 실측 전이다.

**개발 방식 (Vibe Coding 기반 E2E).** 이 제품은 Claude Code 멀티에이전트 팀(Orchestrator·Architect·Backend·Frontend·Reviewer)으로 설계→구현→UI→리뷰 사이클을 돌려 E2E로 구축했다(`.claude/` 역할 정의, `agent-bus/` 에이전트 간 통신 로그). 본인은 **사람 오케스트레이터로서** 제품 스코프와 아키텍처 원칙(provider 추상화, 휴먼 게이트, Electron 보안 게이트웨이)을 정하고, 에이전트 산출물을 리뷰·결정·검증하는 역할을 맡았다 — 즉 'AI 활용 E2E 설계·구축·검증'이며, 한 줄 한 줄을 직접 타이핑한 결과물은 아니다.
