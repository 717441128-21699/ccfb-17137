import './style.css';
import { MapPage } from './ui/map-page';
import { AssemblyPage } from './ui/assembly-page';
import { GamePage } from './ui/game-page';
import { ResultPage } from './ui/result-page';
import { DEFAULT_SELECTION, type SelectionState } from './ui/state';
import type { Settlement } from './game/types';

type Destroyable = { destroy(): void };

class App {
  private root: HTMLElement;
  private page: Destroyable | null = null;
  private selection: SelectionState = { ...DEFAULT_SELECTION };
  private settlement: Settlement | null = null;

  constructor() {
    const root = document.querySelector<HTMLElement>('#app');
    if (!root) throw new Error('缺少 #app 根节点');
    this.root = root;
    try {
      const saved = localStorage.getItem('zhuxiang-raft-selection');
      if (saved) this.selection = { ...this.selection, ...(JSON.parse(saved) as Partial<SelectionState>) };
    } catch {
      /* storage may be unavailable in kiosk mode */
    }
    this.showMap();
  }

  private saveSelection() {
    try {
      localStorage.setItem('zhuxiang-raft-selection', JSON.stringify(this.selection));
    } catch {
      /* ignore */
    }
  }

  private swap(page: Destroyable & { mount(): void }) {
    this.page?.destroy();
    this.root.innerHTML = '';
    this.page = page;
    page.mount();
  }

  showMap = () => {
    this.swap(
      new MapPage(
        this.root,
        this.selection,
        () => this.saveSelection(),
        () => this.showAssembly(),
      ),
    );
  };

  showAssembly = () => {
    this.saveSelection();
    this.swap(
      new AssemblyPage(
        this.root,
        this.selection,
        () => this.showMap(),
        () => this.showGame(),
      ),
    );
  };

  showGame = () => {
    this.saveSelection();
    this.swap(
      new GamePage(
        this.root,
        this.selection,
        (settlement) => {
          this.settlement = settlement;
          this.showResult();
        },
        () => this.showMap(),
      ),
    );
  };

  showResult = () => {
    if (!this.settlement) return this.showMap();
    this.swap(
      new ResultPage(
        this.root,
        this.settlement,
        () => this.showGame(),
        () => this.showAssembly(),
        () => this.showMap(),
      ),
    );
  };
}

new App();
