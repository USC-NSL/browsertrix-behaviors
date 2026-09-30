import { BackgroundBehavior } from "./lib/behavior";
import { sleep } from "./lib/utils";

// build-time variant switches for candidate sources beyond native controls
const USE_CURSOR_POINTER = true;
const USE_CLICK_LISTENERS = true;

// per-element click cap, 1 disables repeat clicking
const MAX_CLICKS = 10;

const LISTENER_EVENTS = ["click", "mousedown", "pointerdown"];

// matched against the element's own name only, not surrounding text
const UNSAFE_NAME =
  /\b(buy|checkout|subscribe|unsubscribe|delete|post|submit|sign in|add to cart)\b/i;

// navigation api is not in the typescript dom lib yet
type NavigateEvent = Event & {
  destination: { sameDocument: boolean; url: string };
};

const CLICK_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
];

export class RevealClick extends BackgroundBehavior {
  _donePromise: Promise<void>;
  _markDone!: () => void;
  selector: string;
  maxClicks: number;
  seenElem = new WeakSet<Element>();
  _listenerElem = new WeakSet<Element>();
  // session-wide, so an element that cycles back to seen content stops
  _seenResources = new Set<string>();
  _seenText = new Set<string>();
  _foundNewResource = false;

  static id = "RevealClick" as const;

  constructor(
    selector = "button, summary, [role=button], [role=tab]",
    maxClicks = MAX_CLICKS,
  ) {
    super();
    this.selector = selector;
    this.maxClicks = maxClicks;
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

  isSafe(elem: Element) {
    if (elem.closest("form") || elem.matches("[type=submit]")) {
      return false;
    }
    const labelIds = elem.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    const name = [
      elem.getAttribute("aria-label"),
      ...labelIds.map((id) => document.getElementById(id)?.textContent),
      elem.getAttribute("title"),
      (elem as HTMLInputElement).value,
      elem.textContent,
    ].join(" ");
    return !UNSAFE_NAME.test(name);
  }

  isCandidate(elem: Element) {
    if (this.seenElem.has(elem) || !elem.isConnected || !this.isSafe(elem)) {
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

  addResources(entries: PerformanceEntryList) {
    for (const entry of entries) {
      if (!this._seenResources.has(entry.name)) {
        this._seenResources.add(entry.name);
        this._foundNewResource = true;
      }
    }
  }

  // records all visible text, true if any of it was not seen before
  addVisibleText() {
    let found = false;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim();
      if (
        text &&
        !this._seenText.has(text) &&
        walker.currentNode.parentElement?.checkVisibility()
      ) {
        this._seenText.add(text);
        found = true;
      }
    }
    return found;
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

    // cancels cross-document navigation before unload, without a dialog
    const navigate = (event: Event) => {
      const { destination } = event as NavigateEvent;
      if (!destination.sameDocument) {
        this.debug("Blocked navigation to: " + destination.url);
        event.preventDefault();
      }
    };
    const navigation = (self as unknown as { navigation?: EventTarget })
      .navigation;

    navigation?.addEventListener("navigate", navigate);

    const observer = new PerformanceObserver((list) =>
      this.addResources(list.getEntries()),
    );
    observer.observe({ type: "resource" });
    this.addResources(performance.getEntriesByType("resource"));
    this.addVisibleText();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
    while (true) {
      const elem = this.nextElem();

      if (!elem) {
        break;
      }

      this.debug("Clicking on element: " + elem.outerHTML.slice(0, 100));

      // keep clicking while each click reveals something new
      let clicks = 1;
      while (
        (await this.processElem(elem, observer)) &&
        clicks < this.maxClicks &&
        elem.isConnected &&
        elem.checkVisibility() &&
        this.isSafe(elem)
      ) {
        clicks++;
      }

      this.debug(`Clicked ${clicks} times`);
    }

    observer.disconnect();

    navigation?.removeEventListener("navigate", navigate);

    window.removeEventListener("beforeunload", beforeUnload);

    this._markDone();
  }

  async processElem(elem: Element, observer: PerformanceObserver) {
    const origHref = self.location.href;
    const origHistoryLen = self.history.length;

    const rect = elem.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    this._foundNewResource = false;

    for (const type of CLICK_EVENTS) {
      elem.dispatchEvent(
        type.startsWith("pointer")
          ? new PointerEvent(type, { ...init, pointerType: "mouse" })
          : new MouseEvent(type, init),
      );
    }

    await sleep(250);

    this.addResources(observer.takeRecords());
    const foundNew = this.addVisibleText() || this._foundNewResource;

    if (self.location.href === origHref) {
      return foundNew;
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

    return false;
  }

  async done() {
    return this._donePromise;
  }
}
