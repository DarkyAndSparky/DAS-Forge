/**
 * Client script: warns before the session ends (WCAG 2.2.1 Timing Adjustable). `warnMs` before the end it opens
 * the dialog "Your session is about to end" with a "Stay signed in" button, which calls POST /session/extend.
 * The server (accounts) says how long is left (GET /session/status) and allows a limited number of extensions;
 * when /session/status is not there (no accounts module) the script does nothing. Needs the modal script (admDialog).
 * Text is set through the dialog's textContent. `warnMs` below 20 s is raised to 20 s; 0 switches the warning off.
 */
import { uiTexts } from './texts.js';

export const MIN_WARN_MS = 20_000;

export function sessionWatchScript({ warnMs = 0 } = {}) {
  if (!(warnMs > 0)) return '';
  const warn = Math.max(MIN_WARN_MS, Math.floor(warnMs));
  const pick = (l) => { const t = uiTexts(l); return { title: t.sessionTitle, text: t.sessionText, extend: t.sessionExtend }; };
  const json = JSON.stringify({ ru: pick('ru'), en: pick('en') }).replace(/</g, '\\u003c');
  return BODY.replace('__TEXTS__', () => json).replace('__WARN__', String(warn));
}

const BODY = `(function(){
var T=__TEXTS__,WARN=__WARN__;
var L=(document.documentElement.lang||'ru').slice(0,2)==='en'?T.en:T.ru;
var timer=null,asking=false;
function status(method){return fetch('/session/'+(method==='POST'?'extend':'status'),{method:method,credentials:'same-origin',headers:{'Accept':'application/json'}}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}
function plan(s){clearTimeout(timer);if(!s||typeof s.remainingMs!=='number'||!window.admDialog)return;
var wait=Math.max(0,s.remainingMs-WARN);timer=setTimeout(function(){ask(s)},wait)}
function ask(s){if(asking)return;asking=true;
status('GET').then(function(cur){if(!cur||cur.remainingMs<=0){asking=false;return}
if(cur.remainingMs>WARN+1000){asking=false;return plan(cur)}
if(!cur.canExtend){asking=false;return}
var secs=Math.max(1,Math.round(cur.remainingMs/1000));
return window.admDialog.confirm(L.text.replace('{s}',secs),{title:L.title,okText:L.extend}).then(function(yes){asking=false;if(yes)return status('POST').then(plan)})})}
document.addEventListener('visibilitychange',function(){if(!document.hidden&&!asking)status('GET').then(plan)});
status('GET').then(plan)})();`;
