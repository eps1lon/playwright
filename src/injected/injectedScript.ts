/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as types from '../types';
import { createAttributeEngine } from './attributeSelectorEngine';
import { createCSSEngine } from './cssSelectorEngine';
import { SelectorEngine, SelectorRoot } from './selectorEngine';
import { createTextSelector } from './textSelectorEngine';
import { XPathEngine } from './xpathSelectorEngine';
import { ParsedSelector } from '../common/selectorParser';
import { FatalDOMError } from '../common/domErrors';

type Predicate<T> = (progress: types.InjectedScriptProgress, continuePolling: symbol) => T | symbol;

export default class InjectedScript {
  readonly engines: Map<string, SelectorEngine>;

  constructor(customEngines: { name: string, engine: SelectorEngine}[]) {
    this.engines = new Map();
    // Note: keep predefined names in sync with Selectors class.
    this.engines.set('css', createCSSEngine(true));
    this.engines.set('css:light', createCSSEngine(false));
    this.engines.set('xpath', XPathEngine);
    this.engines.set('xpath:light', XPathEngine);
    this.engines.set('text', createTextSelector(true));
    this.engines.set('text:light', createTextSelector(false));
    this.engines.set('id', createAttributeEngine('id', true));
    this.engines.set('id:light', createAttributeEngine('id', false));
    this.engines.set('data-testid', createAttributeEngine('data-testid', true));
    this.engines.set('data-testid:light', createAttributeEngine('data-testid', false));
    this.engines.set('data-test-id', createAttributeEngine('data-test-id', true));
    this.engines.set('data-test-id:light', createAttributeEngine('data-test-id', false));
    this.engines.set('data-test', createAttributeEngine('data-test', true));
    this.engines.set('data-test:light', createAttributeEngine('data-test', false));
    for (const {name, engine} of customEngines)
      this.engines.set(name, engine);
  }

  querySelector(selector: ParsedSelector, root: Node): Element | undefined {
    if (!(root as any)['querySelector'])
      throw new Error('Node is not queryable.');
    return this._querySelectorRecursively(root as SelectorRoot, selector, 0);
  }

  private _querySelectorRecursively(root: SelectorRoot, selector: ParsedSelector, index: number): Element | undefined {
    const current = selector.parts[index];
    if (index === selector.parts.length - 1)
      return this.engines.get(current.name)!.query(root, current.body);
    const all = this.engines.get(current.name)!.queryAll(root, current.body);
    for (const next of all) {
      const result = this._querySelectorRecursively(next, selector, index + 1);
      if (result)
        return selector.capture === index ? next : result;
    }
  }

  querySelectorAll(selector: ParsedSelector, root: Node): Element[] {
    if (!(root as any)['querySelectorAll'])
      throw new Error('Node is not queryable.');
    const capture = selector.capture === undefined ? selector.parts.length - 1 : selector.capture;
    // Query all elements up to the capture.
    const partsToQuerAll = selector.parts.slice(0, capture + 1);
    // Check they have a descendant matching everything after the capture.
    const partsToCheckOne = selector.parts.slice(capture + 1);
    let set = new Set<SelectorRoot>([ root as SelectorRoot ]);
    for (const { name, body } of partsToQuerAll) {
      const newSet = new Set<Element>();
      for (const prev of set) {
        for (const next of this.engines.get(name)!.queryAll(prev, body)) {
          if (newSet.has(next))
            continue;
          newSet.add(next);
        }
      }
      set = newSet;
    }
    const candidates = Array.from(set) as Element[];
    if (!partsToCheckOne.length)
      return candidates;
    const partial = { parts: partsToCheckOne };
    return candidates.filter(e => !!this._querySelectorRecursively(e, partial, 0));
  }

  isVisible(element: Element): boolean {
    // Note: this logic should be similar to waitForDisplayedAtStablePosition() to avoid surprises.
    if (!element.ownerDocument || !element.ownerDocument.defaultView)
      return true;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (!style || style.visibility === 'hidden')
      return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  pollRaf<T>(predicate: Predicate<T>): types.InjectedScriptPoll<T> {
    return this._runAbortableTask(progress => {
      let fulfill: (result: T) => void;
      let reject: (error: Error) => void;
      const result = new Promise<T>((f, r) => { fulfill = f; reject = r; });

      const onRaf = () => {
        if (progress.aborted)
          return;
        try {
          const continuePolling = Symbol('continuePolling');
          const success = predicate(progress, continuePolling);
          if (success !== continuePolling)
            fulfill(success as T);
          else
            requestAnimationFrame(onRaf);
        } catch (e) {
          reject(e);
        }
      };

      onRaf();
      return result;
    });
  }

  pollInterval<T>(pollInterval: number, predicate: Predicate<T>): types.InjectedScriptPoll<T> {
    return this._runAbortableTask(progress => {
      let fulfill: (result: T) => void;
      let reject: (error: Error) => void;
      const result = new Promise<T>((f, r) => { fulfill = f; reject = r; });

      const onTimeout = () => {
        if (progress.aborted)
          return;
        try {
          const continuePolling = Symbol('continuePolling');
          const success = predicate(progress, continuePolling);
          if (success !== continuePolling)
            fulfill(success as T);
          else
            setTimeout(onTimeout, pollInterval);
        } catch (e) {
          reject(e);
        }
      };

      onTimeout();
      return result;
    });
  }

  private _runAbortableTask<T>(task: (progess: types.InjectedScriptProgress) => Promise<T>): types.InjectedScriptPoll<T> {
    let unsentLogs: string[] = [];
    let takeNextLogsCallback: ((logs: string[]) => void) | undefined;
    const logReady = () => {
      if (!takeNextLogsCallback)
        return;
      takeNextLogsCallback(unsentLogs);
      unsentLogs = [];
      takeNextLogsCallback = undefined;
    };

    const takeNextLogs = () => new Promise<string[]>(fulfill => {
      takeNextLogsCallback = fulfill;
      if (unsentLogs.length)
        logReady();
    });

    let lastLog = '';
    const progress: types.InjectedScriptProgress = {
      aborted: false,
      log: (message: string) => {
        lastLog = message;
        unsentLogs.push(message);
        logReady();
      },
      logRepeating: (message: string) => {
        if (message !== lastLog)
          progress.log(message);
      },
    };

    return {
      takeNextLogs,
      result: task(progress),
      cancel: () => { progress.aborted = true; },
      takeLastLogs: () => unsentLogs,
    };
  }

  getElementBorderWidth(node: Node): { left: number; top: number; } {
    if (node.nodeType !== Node.ELEMENT_NODE || !node.ownerDocument || !node.ownerDocument.defaultView)
      return { left: 0, top: 0 };
    const style = node.ownerDocument.defaultView.getComputedStyle(node as Element);
    return { left: parseInt(style.borderLeftWidth || '', 10), top: parseInt(style.borderTopWidth || '', 10) };
  }

  selectOptions(node: Node, optionsToSelect: (Node | types.SelectOption)[]): string[] | 'error:notconnected' | FatalDOMError {
    if (node.nodeName.toLowerCase() !== 'select')
      return 'error:notselect';
    if (!node.isConnected)
      return 'error:notconnected';
    const element = node as HTMLSelectElement;

    const options = Array.from(element.options);
    element.value = undefined as any;
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      option.selected = optionsToSelect.some(optionToSelect => {
        if (optionToSelect instanceof Node)
          return option === optionToSelect;
        let matches = true;
        if (optionToSelect.value !== undefined)
          matches = matches && optionToSelect.value === option.value;
        if (optionToSelect.label !== undefined)
          matches = matches && optionToSelect.label === option.label;
        if (optionToSelect.index !== undefined)
          matches = matches && optionToSelect.index === index;
        return matches;
      });
      if (option.selected && !element.multiple)
        break;
    }
    element.dispatchEvent(new Event('input', { 'bubbles': true }));
    element.dispatchEvent(new Event('change', { 'bubbles': true }));
    return options.filter(option => option.selected).map(option => option.value);
  }

  waitForEnabledAndFill(node: Node, value: string): types.InjectedScriptPoll<FatalDOMError | 'error:notconnected' | 'needsinput' | 'done'> {
    return this.pollRaf((progress, continuePolling) => {
      if (node.nodeType !== Node.ELEMENT_NODE)
        return 'error:notelement';
      const element = node as Element;
      if (!element.isConnected)
        return 'error:notconnected';
      if (!this.isVisible(element)) {
        progress.logRepeating('    element is not visible - waiting...');
        return continuePolling;
      }
      if (element.nodeName.toLowerCase() === 'input') {
        const input = element as HTMLInputElement;
        const type = (input.getAttribute('type') || '').toLowerCase();
        const kDateTypes = new Set(['date', 'time', 'datetime', 'datetime-local']);
        const kTextInputTypes = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
        if (!kTextInputTypes.has(type) && !kDateTypes.has(type)) {
          progress.log(`    input of type "${type}" cannot be filled`);
          return 'error:notfillableinputtype';
        }
        if (type === 'number') {
          value = value.trim();
          if (isNaN(Number(value)))
            return 'error:notfillablenumberinput';
        }
        if (input.disabled) {
          progress.logRepeating('    element is disabled - waiting...');
          return continuePolling;
        }
        if (input.readOnly) {
          progress.logRepeating('    element is readonly - waiting...');
          return continuePolling;
        }
        if (kDateTypes.has(type)) {
          value = value.trim();
          input.focus();
          input.value = value;
          if (input.value !== value)
            return 'error:notvaliddate';
          element.dispatchEvent(new Event('input', { 'bubbles': true }));
          element.dispatchEvent(new Event('change', { 'bubbles': true }));
          return 'done';  // We have already changed the value, no need to input it.
        }
      } else if (element.nodeName.toLowerCase() === 'textarea') {
        const textarea = element as HTMLTextAreaElement;
        if (textarea.disabled) {
          progress.logRepeating('    element is disabled - waiting...');
          return continuePolling;
        }
        if (textarea.readOnly) {
          progress.logRepeating('    element is readonly - waiting...');
          return continuePolling;
        }
      } else if (!(element as HTMLElement).isContentEditable) {
        return 'error:notfillableelement';
      }
      const result = this._selectText(element);
      if (result === 'error:notvisible') {
        progress.logRepeating('    element is not visible - waiting...');
        return continuePolling;
      }
      return 'needsinput';  // Still need to input the value.
    });
  }

  waitForVisibleAndSelectText(node: Node): types.InjectedScriptPoll<FatalDOMError | 'error:notconnected' | 'done'> {
    return this.pollRaf((progress, continuePolling) => {
      if (node.nodeType !== Node.ELEMENT_NODE)
        return 'error:notelement';
      if (!node.isConnected)
        return 'error:notconnected';
      const element = node as Element;
      if (!this.isVisible(element)) {
        progress.logRepeating('    element is not visible - waiting...');
        return continuePolling;
      }
      const result = this._selectText(element);
      if (result === 'error:notvisible') {
        progress.logRepeating('    element is not visible - waiting...');
        return continuePolling;
      }
      return result;
    });
  }

  private _selectText(element: Element): 'error:notvisible' | 'error:notconnected' | 'done' {
    if (element.nodeName.toLowerCase() === 'input') {
      const input = element as HTMLInputElement;
      input.select();
      input.focus();
      return 'done';
    }
    if (element.nodeName.toLowerCase() === 'textarea') {
      const textarea = element as HTMLTextAreaElement;
      textarea.selectionStart = 0;
      textarea.selectionEnd = textarea.value.length;
      textarea.focus();
      return 'done';
    }
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.defaultView!.getSelection();
    if (!selection)
      return 'error:notvisible';
    selection.removeAllRanges();
    selection.addRange(range);
    (element as HTMLElement | SVGElement).focus();
    return 'done';
  }

  waitForNodeVisible(node: Node): types.InjectedScriptPoll<'error:notconnected' | 'done'> {
    return this.pollRaf((progress, continuePolling) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      if (!node.isConnected || !element)
        return 'error:notconnected';
      if (!this.isVisible(element)) {
        progress.logRepeating('    element is not visible - waiting...');
        return continuePolling;
      }
      return 'done';
    });
  }

  focusNode(node: Node): FatalDOMError | 'error:notconnected' | 'done' {
    if (!node.isConnected)
      return 'error:notconnected';
    if (node.nodeType !== Node.ELEMENT_NODE)
      return 'error:notelement';
    (node as HTMLElement | SVGElement).focus();
    return 'done';
  }

  isCheckboxChecked(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw new Error('Not a checkbox or radio button');

    let element: Element | undefined = node as Element;
    if (element.getAttribute('role') === 'checkbox')
      return element.getAttribute('aria-checked') === 'true';

    if (element.nodeName === 'LABEL') {
      const forId = element.getAttribute('for');
      if (forId && element.ownerDocument)
        element = element.ownerDocument.querySelector(`input[id="${forId}"]`) || undefined;
      else
        element = element.querySelector('input[type=checkbox],input[type=radio]') || undefined;
    }
    if (element && element.nodeName === 'INPUT') {
      const type = element.getAttribute('type');
      if (type && (type.toLowerCase() === 'checkbox' || type.toLowerCase() === 'radio'))
        return (element as HTMLInputElement).checked;
    }
    throw new Error('Not a checkbox');
  }

  async setInputFiles(node: Node, payloads: types.FileTransferPayload[]) {
    if (node.nodeType !== Node.ELEMENT_NODE)
      return 'Node is not of type HTMLElement';
    const element: Element | undefined = node as Element;
    if (element.nodeName !== 'INPUT')
      return 'Not an <input> element';
    const input = element as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (type !== 'file')
      return 'Not an input[type=file] element';

    const files = await Promise.all(payloads.map(async file => {
      const result = await fetch(`data:${file.type};base64,${file.data}`);
      return new File([await result.blob()], file.name, {type: file.type});
    }));
    const dt = new DataTransfer();
    for (const file of files)
      dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { 'bubbles': true }));
    input.dispatchEvent(new Event('change', { 'bubbles': true }));
  }

  waitForDisplayedAtStablePositionAndEnabled(node: Node, rafCount: number): types.InjectedScriptPoll<'error:notconnected' | 'done'> {
    let lastRect: types.Rect | undefined;
    let counter = 0;
    let samePositionCounter = 0;
    let lastTime = 0;

    return this.pollRaf((progress, continuePolling) => {
      // First raf happens in the same animation frame as evaluation, so it does not produce
      // any client rect difference compared to synchronous call. We skip the synchronous call
      // and only force layout during actual rafs as a small optimisation.
      if (++counter === 1)
        return continuePolling;

      if (!node.isConnected)
        return 'error:notconnected';
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (!element)
        return 'error:notconnected';

      // Drop frames that are shorter than 16ms - WebKit Win bug.
      const time = performance.now();
      if (rafCount > 1 && time - lastTime < 15)
        return continuePolling;
      lastTime = time;

      // Note: this logic should be similar to isVisible() to avoid surprises.
      const clientRect = element.getBoundingClientRect();
      const rect = { x: clientRect.top, y: clientRect.left, width: clientRect.width, height: clientRect.height };
      const samePosition = lastRect && rect.x === lastRect.x && rect.y === lastRect.y && rect.width === lastRect.width && rect.height === lastRect.height;
      const isDisplayed = rect.width > 0 && rect.height > 0;
      if (samePosition)
        ++samePositionCounter;
      else
        samePositionCounter = 0;
      const isStable = samePositionCounter >= rafCount;
      const isStableForLogs = isStable || !lastRect;
      lastRect = rect;

      const style = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView.getComputedStyle(element) : undefined;
      const isVisible = !!style && style.visibility !== 'hidden';

      const elementOrButton = element.closest('button, [role=button]') || element;
      const isDisabled = ['BUTTON', 'INPUT', 'SELECT'].includes(elementOrButton.nodeName) && elementOrButton.hasAttribute('disabled');

      if (isDisplayed && isStable && isVisible && !isDisabled)
        return 'done';

      if (!isDisplayed || !isVisible)
        progress.logRepeating(`    element is not visible - waiting...`);
      else if (!isStableForLogs)
        progress.logRepeating(`    element is moving - waiting...`);
      else if (isDisabled)
        progress.logRepeating(`    element is disabled - waiting...`);
      return continuePolling;
    });
  }

  checkHitTargetAt(node: Node, point: types.Point): 'error:notconnected' | 'error:nothittarget' | 'done' {
    let element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!element || !element.isConnected)
      return 'error:notconnected';
    element = element.closest('button, [role=button]') || element;
    let hitElement = this.deepElementFromPoint(document, point.x, point.y);
    while (hitElement && hitElement !== element)
      hitElement = this._parentElementOrShadowHost(hitElement);
    return hitElement === element ? 'done' : 'error:nothittarget';
  }

  dispatchEvent(node: Node, type: string, eventInit: Object) {
    let event;
    eventInit = { bubbles: true, cancelable: true, composed: true, ...eventInit };
    switch (eventType.get(type)) {
      case 'mouse': event = new MouseEvent(type, eventInit); break;
      case 'keyboard': event = new KeyboardEvent(type, eventInit); break;
      case 'touch': event = new TouchEvent(type, eventInit); break;
      case 'pointer': event = new PointerEvent(type, eventInit); break;
      case 'focus': event = new FocusEvent(type, eventInit); break;
      case 'drag': event = new DragEvent(type, eventInit); break;
      default: event = new Event(type, eventInit); break;
    }
    node.dispatchEvent(event);
  }

  private _parentElementOrShadowHost(element: Element): Element | undefined {
    if (element.parentElement)
      return element.parentElement;
    if (!element.parentNode)
      return;
    if (element.parentNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (element.parentNode as ShadowRoot).host)
      return (element.parentNode as ShadowRoot).host;
  }

  deepElementFromPoint(document: Document, x: number, y: number): Element | undefined {
    let container: Document | ShadowRoot | null = document;
    let element: Element | undefined;
    while (container) {
      const innerElement = container.elementFromPoint(x, y) as Element | undefined;
      if (!innerElement || element === innerElement)
        break;
      element = innerElement;
      container = element.shadowRoot;
    }
    return element;
  }

  previewNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE)
      return oneLine(`#text=${node.nodeValue || ''}`);
    if (node.nodeType !== Node.ELEMENT_NODE)
      return oneLine(`<${node.nodeName.toLowerCase()} />`);
    const element = node as Element;

    const attrs = [];
    for (let i = 0; i < element.attributes.length; i++) {
      const { name, value } = element.attributes[i];
      if (name === 'style')
        continue;
      if (!value && booleanAttributes.has(name))
        attrs.push(` ${name}`);
      else
        attrs.push(` ${name}="${value}"`);
    }
    attrs.sort((a, b) => a.length - b.length);
    let attrText = attrs.join('');
    if (attrText.length > 50)
      attrText = attrText.substring(0, 49) + '\u2026';
    if (autoClosingTags.has(element.nodeName))
      return oneLine(`<${element.nodeName.toLowerCase()}${attrText}/>`);

    const children = element.childNodes;
    let onlyText = false;
    if (children.length <= 5) {
      onlyText = true;
      for (let i = 0; i < children.length; i++)
        onlyText = onlyText && children[i].nodeType === Node.TEXT_NODE;
    }
    let text = onlyText ? (element.textContent || '') : (children.length ? '\u2026' : '');
    if (text.length > 50)
      text = text.substring(0, 49) + '\u2026';
    return oneLine(`<${element.nodeName.toLowerCase()}${attrText}>${text}</${element.nodeName.toLowerCase()}>`);
  }
}

const autoClosingTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
const booleanAttributes = new Set(['checked', 'selected', 'disabled', 'readonly', 'multiple']);

function oneLine(s: string): string {
  return s.replace(/\n/g, '↵').replace(/\t/g, '⇆');
}

const eventType = new Map<string, 'mouse'|'keyboard'|'touch'|'pointer'|'focus'|'drag'>([
  ['auxclick', 'mouse'],
  ['click', 'mouse'],
  ['dblclick', 'mouse'],
  ['mousedown','mouse'],
  ['mouseeenter', 'mouse'],
  ['mouseleave', 'mouse'],
  ['mousemove', 'mouse'],
  ['mouseout', 'mouse'],
  ['mouseover', 'mouse'],
  ['mouseup', 'mouse'],
  ['mouseleave', 'mouse'],
  ['mousewheel', 'mouse'],

  ['keydown', 'keyboard'],
  ['keyup', 'keyboard'],
  ['keypress', 'keyboard'],
  ['textInput', 'keyboard'],

  ['touchstart', 'touch'],
  ['touchmove', 'touch'],
  ['touchend', 'touch'],
  ['touchcancel', 'touch'],

  ['pointerover', 'pointer'],
  ['pointerout', 'pointer'],
  ['pointerenter', 'pointer'],
  ['pointerleave', 'pointer'],
  ['pointerdown', 'pointer'],
  ['pointerup', 'pointer'],
  ['pointermove', 'pointer'],
  ['pointercancel', 'pointer'],
  ['gotpointercapture', 'pointer'],
  ['lostpointercapture', 'pointer'],

  ['focus', 'focus'],
  ['blur', 'focus'],

  ['drag', 'drag'],
  ['dragstart', 'drag'],
  ['dragend', 'drag'],
  ['dragover', 'drag'],
  ['dragenter', 'drag'],
  ['dragleave', 'drag'],
  ['dragexit', 'drag'],
  ['drop', 'drag'],
]);
