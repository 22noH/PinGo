// review-stream.ts — 스트리밍 렌더링/자동 스크롤/파일 목록 관리
import type { MRChange } from '../../shared/types';
import { renderPartial } from './review-markdown';

export interface StreamView {
  markdown: HTMLElement;
  cursorEl: HTMLElement;
  scroll: HTMLElement;
  fileList: HTMLUListElement;
  fileCount: HTMLElement;
  scrollBtn: HTMLButtonElement;
}

export class StreamController {
  private buffer = '';
  private userScrolledUp = false;

  constructor(private view: StreamView, private onFileClick: (change: MRChange) => void) {
    this.view.scroll.addEventListener('scroll', () => this.onScroll());
    this.view.scrollBtn.addEventListener('click', () => {
      this.userScrolledUp = false;
      this.view.scrollBtn.hidden = true;
      this.scrollToBottom('smooth');
    });
  }

  reset(): void {
    this.buffer = '';
    this.userScrolledUp = false;
    this.view.markdown.innerHTML = '';
    this.view.markdown.hidden = false;
    this.view.scrollBtn.hidden = true;
    this.ensureCursor();
  }

  append(chunk: string): void {
    this.buffer += chunk;
    this.render();
    if (!this.userScrolledUp) this.scrollToBottom('auto');
  }

  finalize(): void {
    this.render(true);
    this.removeCursor();
  }

  getFullText(): string {
    return this.buffer;
  }

  /** MergeRequestWithChanges 수신 시 파일 목록 패널 렌더 */
  setFileList(changes: MRChange[]): void {
    this.view.fileList.innerHTML = '';
    if (changes.length === 0) {
      this.renderEmpty('변경 파일이 없습니다.');
      this.view.fileCount.textContent = '0';
      this.view.fileCount.className = 'badge badge-muted';
      return;
    }
    for (const ch of changes) this.addFileItem(ch);
    this.view.fileCount.textContent = String(changes.length);
    this.view.fileCount.className = 'badge badge-info';
  }

  /** 초기 대기 상태 안내 (changes 미도착) */
  renderWaitingForChanges(): void {
    this.renderEmpty('파일 목록을 불러오는 중…');
    this.view.fileCount.textContent = '0';
    this.view.fileCount.className = 'badge badge-muted';
  }

  /** 초기 idle 상태 안내 */
  renderInitialEmpty(): void {
    this.renderEmpty('리뷰가 시작되면 여기에 파일이 표시됩니다.');
  }

  private renderEmpty(message: string): void {
    const li = document.createElement('li');
    li.className = 'file-empty text-muted';
    li.textContent = message;
    this.view.fileList.innerHTML = '';
    this.view.fileList.appendChild(li);
  }

  private render(final = false): void {
    const html = renderPartial(this.buffer);
    this.view.markdown.innerHTML = html;
    if (!final) this.appendCursor();
  }

  private ensureCursor(): void {
    this.view.markdown.innerHTML = '';
    this.appendCursor();
  }

  private appendCursor(): void {
    if (!this.view.markdown.querySelector('.stream-cursor')) {
      const cur = document.createElement('span');
      cur.className = 'stream-cursor';
      cur.setAttribute('aria-hidden', 'true');
      this.view.markdown.appendChild(cur);
    }
  }

  private removeCursor(): void {
    this.view.markdown.querySelectorAll('.stream-cursor').forEach(n => n.remove());
  }

  private scrollToBottom(behavior: ScrollBehavior): void {
    this.view.scroll.scrollTo({ top: this.view.scroll.scrollHeight, behavior });
  }

  private onScroll(): void {
    const el = this.view.scroll;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    if (!atBottom) {
      this.userScrolledUp = true;
      this.view.scrollBtn.hidden = false;
    } else {
      this.userScrolledUp = false;
      this.view.scrollBtn.hidden = true;
    }
  }

  private addFileItem(change: MRChange): void {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const displayPath = change.new_path || change.old_path;
    li.title = `${displayPath} — 클릭하여 diff 보기`;

    const pathEl = document.createElement('div');
    pathEl.className = 'file-item-path truncate';
    pathEl.textContent = displayPath;
    li.appendChild(pathEl);

    // 추가/삭제 라인 수 + 상태 배지
    const sub = document.createElement('div');
    sub.className = 'file-item-sub';
    const stats = countDiffStats(change.diff);
    if (change.new_file) sub.appendChild(makeBadge('new', '새 파일'));
    else if (change.deleted_file) sub.appendChild(makeBadge('del-file', '삭제'));
    else if (change.renamed_file) sub.appendChild(makeBadge('rename', '이름 변경'));
    if (stats.add > 0) sub.appendChild(makeBadge('add', `+${stats.add}`));
    if (stats.del > 0) sub.appendChild(makeBadge('del', `−${stats.del}`));
    li.appendChild(sub);

    li.addEventListener('click', () => this.onFileClick(change));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.onFileClick(change);
      }
    });
    this.view.fileList.appendChild(li);
  }
}

function makeBadge(kind: 'add' | 'del' | 'new' | 'del-file' | 'rename', text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `badge badge-${kind}`;
  span.textContent = text;
  return span;
}

function countDiffStats(diff: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}
