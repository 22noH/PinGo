// settings-ai.ts — [AI] 탭 로직 (엔트리)
// provider 드롭다운 + 필드 스위칭 + 가용성/연결 테스트 orchestration
// 폼 빌더/Ollama 로딩은 settings-ai-fields.ts 에 위임 (300줄 제한)
import type {
  AIConfig,
  AIProviderType,
  AIAvailabilityTestResult,
  AnthropicAPIConfig,
  OpenAIAPIConfig,
  OllamaConfig,
  ClaudeCLIConfig,
  CodexCLIConfig,
} from '../../shared/types';
import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  OPENAI_MODELS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  CLAUDE_CLI_MODELS,
  CLAUDE_CLI_EFFORTS,
  CODEX_CLI_MODELS,
  CODEX_CLI_EFFORTS,
} from '../../shared/constants';
import type { ClaudeCLIEffort, CodexCLIEffort } from '../../shared/types';
import {
  makeInput, makeTokenField, makeModelSelect,
  makeOllamaModelField, loadOllamaModels, showStatus,
} from './settings-ai-fields';

// ── 상태 ─────────────────────────────────────────────────────
let current: AIConfig = { type: 'claude-cli' };
let dirty = false;

// ── DOM ──────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const providerSel = $<HTMLSelectElement>('ai-provider');
const fieldsHost  = $<HTMLDivElement>('ai-fields');
const testBtn     = $<HTMLButtonElement>('btn-ai-test');
const testLabel   = $<HTMLSpanElement>('ai-test-label');
const testResult  = $<HTMLSpanElement>('ai-test-result');

// ── Public API ───────────────────────────────────────────────
export function initAITab(initial: AIConfig): void {
  current = initial;
  providerSel.value = initial.type;
  applyProvider(initial.type);
  dirty = false;

  // 저장된 최신 AI 설정이 있으면 덮어쓰기
  void window.electronAPI.loadAIConfig().then((r): void => {
    if (r && r.ai && r.ai.type === providerSel.value) {
      current = r.ai;
      applyProvider(current.type);
    }
  }).catch((): void => { /* ignore — initial 사용 */ });

  providerSel.addEventListener('change', (): void => {
    const t = providerSel.value as AIProviderType;
    current = defaultConfigFor(t);
    dirty = true;
    applyProvider(t);
  });
  testBtn.addEventListener('click', (): void => { void runTest(); });
}

export function flushAIPendingChanges(): AIConfig {
  readFormIntoCurrent();
  return current;
}

export function hasUnsavedAIChanges(): boolean {
  return dirty;
}

// ── 필드 스위치 ──────────────────────────────────────────────
function applyProvider(type: AIProviderType): void {
  testLabel.textContent = (type === 'claude-cli' || type === 'codex-cli')
    ? '가용성 확인' : '연결 테스트';
  testResult.hidden = true;
  fieldsHost.innerHTML = '';

  switch (type) {
    case 'claude-cli':
    case 'codex-cli':
      fieldsHost.appendChild(renderCLIFields(type,
        current.type === type ? (current as ClaudeCLIConfig | CodexCLIConfig) : { type }));
      break;
    case 'anthropic-api':
      fieldsHost.appendChild(renderAnthropicFields(
        current.type === 'anthropic-api' ? current : defaultAnthropic()));
      break;
    case 'openai-api':
      fieldsHost.appendChild(renderOpenAIFields(
        current.type === 'openai-api' ? current : defaultOpenAI()));
      break;
    case 'ollama':
      fieldsHost.appendChild(renderOllamaFields(
        current.type === 'ollama' ? current : defaultOllama()));
      break;
    default: break;
  }
}

function renderCLIFields(
  type: 'claude-cli' | 'codex-cli', cfg: ClaudeCLIConfig | CodexCLIConfig,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'col';
  wrap.style.gap = 'var(--space-4)';
  wrap.appendChild(makeInput('실행 파일 경로', 'ai-exec-path', 'text',
    cfg.execPath ?? '',
    type === 'claude-cli' ? '/usr/local/bin/claude' : '/usr/local/bin/codex',
    '비워두면 PATH에서 자동 탐색'));

  // claude-cli / codex-cli 전용: 모델 + effort (토큰 예산)
  if (type === 'claude-cli') {
    const c = cfg as ClaudeCLIConfig;
    wrap.appendChild(makeModelSelect(
      'ai-cli-model',
      c.model ?? '',
      Array.from(CLAUDE_CLI_MODELS),
      '모델 (별칭)',
    ));
    wrap.appendChild(makeModelSelect(
      'ai-cli-effort',
      c.effort ?? '',
      Array.from(CLAUDE_CLI_EFFORTS),
      'Effort (토큰 예산)',
    ));
  } else {
    // codex-cli
    const c = cfg as CodexCLIConfig;
    wrap.appendChild(makeModelSelect(
      'ai-cli-model',
      c.model ?? '',
      Array.from(CODEX_CLI_MODELS),
      '모델',
    ));
    wrap.appendChild(makeModelSelect(
      'ai-cli-effort',
      c.reasoningEffort ?? '',
      Array.from(CODEX_CLI_EFFORTS),
      'Reasoning Effort',
    ));
  }

  bindDirty(wrap);
  return wrap;
}

function renderAnthropicFields(cfg: AnthropicAPIConfig): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'col';
  wrap.style.gap = 'var(--space-4)';
  wrap.appendChild(makeTokenField('ai-api-key', cfg.apiKey ?? '', 'sk-ant-…'));
  wrap.appendChild(makeModelSelect('ai-model', cfg.model || DEFAULT_ANTHROPIC_MODEL,
    Array.from(ANTHROPIC_MODELS), '모델'));
  bindDirty(wrap);
  return wrap;
}

function renderOpenAIFields(cfg: OpenAIAPIConfig): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'col';
  wrap.style.gap = 'var(--space-4)';
  wrap.appendChild(makeTokenField('ai-api-key', cfg.apiKey ?? '', 'sk-…'));
  wrap.appendChild(makeModelSelect('ai-model', cfg.model || DEFAULT_OPENAI_MODEL,
    Array.from(OPENAI_MODELS), '모델'));
  wrap.appendChild(makeInput('Base URL', 'ai-base-url', 'url',
    cfg.baseUrl ?? DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_BASE_URL,
    'Azure OpenAI / 호환 엔드포인트 변경 가능'));
  bindDirty(wrap);
  return wrap;
}

function renderOllamaFields(cfg: OllamaConfig): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'col';
  wrap.style.gap = 'var(--space-4)';
  wrap.appendChild(makeInput('Base URL', 'ai-base-url', 'url',
    cfg.baseUrl || DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL));
  wrap.appendChild(makeOllamaModelField());
  void loadOllamaModels(wrap, cfg.baseUrl || DEFAULT_OLLAMA_BASE_URL, cfg.model);
  bindDirty(wrap);
  return wrap;
}

function bindDirty(host: HTMLElement): void {
  const onChange = (): void => { dirty = true; };
  host.querySelectorAll('input,select').forEach(el => {
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  });
}

// ── 폼 값 → current 반영 ────────────────────────────────────
function readFormIntoCurrent(): void {
  const t = providerSel.value as AIProviderType;
  const val = (id: string): string => {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value.trim();
    return '';
  };
  if (t === 'claude-cli') {
    const execPath = val('ai-exec-path') || undefined;
    const model = val('ai-cli-model') || undefined;
    const effortRaw = val('ai-cli-effort');
    const validEfforts: ReadonlyArray<ClaudeCLIEffort> = ['low', 'medium', 'high', 'xhigh', 'max'];
    const effort = (validEfforts as readonly string[]).includes(effortRaw)
      ? (effortRaw as ClaudeCLIEffort)
      : undefined;
    current = { type: 'claude-cli', execPath, model, effort };
  } else if (t === 'codex-cli') {
    const execPath = val('ai-exec-path') || undefined;
    const model = val('ai-cli-model') || undefined;
    const effortRaw = val('ai-cli-effort');
    const validEfforts: ReadonlyArray<CodexCLIEffort> = ['minimal', 'low', 'medium', 'high'];
    const reasoningEffort = (validEfforts as readonly string[]).includes(effortRaw)
      ? (effortRaw as CodexCLIEffort)
      : undefined;
    current = { type: 'codex-cli', execPath, model, reasoningEffort };
  } else if (t === 'anthropic-api') {
    current = {
      type: 'anthropic-api', apiKey: val('ai-api-key'),
      model: val('ai-model') || DEFAULT_ANTHROPIC_MODEL,
    };
  } else if (t === 'openai-api') {
    current = {
      type: 'openai-api', apiKey: val('ai-api-key'),
      model: val('ai-model') || DEFAULT_OPENAI_MODEL,
      baseUrl: val('ai-base-url') || DEFAULT_OPENAI_BASE_URL,
    };
  } else if (t === 'ollama') {
    current = {
      type: 'ollama',
      baseUrl: val('ai-base-url') || DEFAULT_OLLAMA_BASE_URL,
      model: val('ai-model'),
    };
  }
}

// ── 가용성 / 연결 테스트 ────────────────────────────────────
async function runTest(): Promise<void> {
  readFormIntoCurrent();
  testBtn.disabled = true;
  showStatus(testResult, 'loading', '테스트 중…');
  try {
    const r: AIAvailabilityTestResult =
      await window.electronAPI.testAIAvailability({ config: current });
    if (r.success) {
      const detail = r.version ? ` · ${r.version}` : '';
      showStatus(testResult, 'success', `가용함${detail}`);
    } else {
      showStatus(testResult, 'error', r.error ?? '가용성 확인 실패');
    }
    if (current.type === 'ollama' && r.success) {
      void loadOllamaModels(fieldsHost, current.baseUrl, current.model);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(testResult, 'error', `IPC 오류: ${msg}`);
  } finally {
    testBtn.disabled = false;
  }
}

// ── 기본값 ───────────────────────────────────────────────────
function defaultConfigFor(t: AIProviderType): AIConfig {
  switch (t) {
    case 'claude-cli': return { type: 'claude-cli' };
    case 'codex-cli':  return { type: 'codex-cli' };
    case 'anthropic-api': return defaultAnthropic();
    case 'openai-api':    return defaultOpenAI();
    case 'ollama':        return defaultOllama();
    default:              return { type: 'claude-cli' };
  }
}
function defaultAnthropic(): AnthropicAPIConfig {
  return { type: 'anthropic-api', apiKey: '', model: DEFAULT_ANTHROPIC_MODEL };
}
function defaultOpenAI(): OpenAIAPIConfig {
  return { type: 'openai-api', apiKey: '', model: DEFAULT_OPENAI_MODEL, baseUrl: DEFAULT_OPENAI_BASE_URL };
}
function defaultOllama(): OllamaConfig {
  return { type: 'ollama', baseUrl: DEFAULT_OLLAMA_BASE_URL, model: '' };
}
