import { BackgroundBehavior } from "./lib/behavior";
import { sleep } from "./lib/utils";

// build-time variant switches for candidate sources beyond native controls
const USE_CURSOR_POINTER = true;
const USE_CLICK_LISTENERS = true;

const LISTENER_EVENTS = ["click", "mousedown", "pointerdown"];

export class RevealClick extends BackgroundBehavior {
  _donePromise: Promise<void>;
  _markDone!: () => void;
  selector: string;
  seenElem = new WeakSet<Element>();
  _listenerElem = new WeakSet<Element>();

  static id = "RevealClick" as const;

  constructor(selector = "button, summary, [role=button], [role=tab]") {
    super();
    this.selector = selector;
    this._donePromise = new Promise<void>(
      (resolve) => (this._markDone = resolve),
    );

    if (USE_CLICK_LISTENERS) {
      // runs before page scripts, so sees handlers the page attaches
      const listenerElem = this._listenerElem;
      const addEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        ...args: Parameters<EventTarget["addEventListener"]>
      ) {
        // document and window are root delegation, covered by cursor: pointer
        if (this instanceof Element && LISTENER_EVENTS.includes(args[0])) {
          listenerElem.add(this);
        }
        addEventListener.apply(this, args);
      };
    }
  }

  isCandidate(elem: Element) {
    if (this.seenElem.has(elem) || !elem.isConnected) {
      return false;
    }
    // only same-document links, following others would unload the page
    const link = elem.closest("a[href]") as HTMLAnchorElement | null;
    if (link && link.href.split("#")[0] !== self.location.href.split("#")[0]) {
      return false;
    }
    if (!elem.checkVisibility()) {
      return false;
    }
    this.seenElem.add(elem);
    return true;
  }

  nextElem(): Element | null {
    try {
      for (const elem of document.querySelectorAll(this.selector)) {
        if (this.isCandidate(elem)) {
          return elem;
        }
      }

      const allElems = document.body.querySelectorAll("*");

      if (USE_CURSOR_POINTER) {
        for (const elem of allElems) {
          // cursor is inherited, only take the outermost pointer element
          if (
            !this.seenElem.has(elem) &&
            getComputedStyle(elem).cursor === "pointer" &&
            !(
              elem.parentElement &&
              getComputedStyle(elem.parentElement).cursor === "pointer"
            ) &&
            this.isCandidate(elem)
          ) {
            return elem;
          }
        }
      }

      if (USE_CLICK_LISTENERS) {
        for (const elem of allElems) {
          if (
            (this._listenerElem.has(elem) || (elem as HTMLElement).onclick) &&
            this.isCandidate(elem)
          ) {
            return elem;
          }
        }
      }
    } catch (e) {
      this.debug((e as Error).toString());
    }

    return null;
  }

  async start() {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      return false;
    };

    window.addEventListener("beforeunload", beforeUnload);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
    while (true) {
      const elem = this.nextElem();

      if (!elem) {
        break;
      }

      await this.processElem(elem);
    }

    window.removeEventListener("beforeunload", beforeUnload);

    this._markDone();
  }

  async processElem(elem: Element) {
    this.debug("Clicking on element: " + elem.outerHTML.slice(0, 100));

    const origHref = self.location.href;
    const origHistoryLen = self.history.length;

    // handlers may listen for press rather than click
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      elem.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    if (elem instanceof HTMLElement) {
      elem.click();
    } else {
      elem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    await sleep(250);

    if (self.location.href === origHref) {
      return;
    }

    this.debug("Click changed URL, restoring: " + self.location.href);

    if (self.history.length === origHistoryLen + 1) {
      await new Promise((resolve) => {
        window.addEventListener(
          "popstate",
          () => {
            resolve(null);
          },
          { once: true },
        );

        window.history.back();
      });
    } else {
      self.history.replaceState(self.history.state, "", origHref);
    }
  }

  async done() {
    return this._donePromise;
  }
}
