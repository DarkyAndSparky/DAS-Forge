/**
 * Client script for modal dialogs: `admDialog.alert / confirm / prompt` (Promises) instead of the browser's
 * alert/confirm/prompt, plus `data-confirm="text"` on a button or submit button (asks first, then proceeds).
 * Built on <dialog>: focus trap, Esc and backdrop click cancel. Text is always set with textContent.
 * Styles: `dialog.adm-dialog` in theme.js. Loaded by renderAppShell; any page can include it with themeHead.
 */
import { uiTexts } from './texts.js';

const pick = (l) => { const t = uiTexts(l); return { ok: t.dialogOk, cancel: t.dialogCancel, yes: t.dialogYes, close: t.dialogClose }; };
/** The script with both languages' button texts embedded (overrides included); the page language picks one. */
export function modalScript() {
  const json = JSON.stringify({ ru: pick('ru'), en: pick('en') }).replace(/</g, '\\u003c');
  return BODY.replace('__TEXTS__', () => json);
}

const BODY = `(function(){
var T=__TEXTS__;
var L=(document.documentElement.lang||'ru').slice(0,2)==='en'?T.en:T.ru;
function open(kind,message,o){o=o||{};
return new Promise(function(resolve){
var d=document.createElement('dialog');d.className='adm-dialog';d.setAttribute('aria-modal','true');
var f=document.createElement('form');f.method='dialog';
if(o.title){var h=document.createElement('h2');h.textContent=o.title;f.appendChild(h)}
var p=document.createElement('p');p.textContent=message;f.appendChild(p);
var input=null;
if(kind==='prompt'){input=document.createElement('input');input.className='adm-input';input.type=o.type||'text';input.value=o.value||'';input.style.width='100%';f.appendChild(input)}
var row=document.createElement('div');row.className='adm-dialog-actions';
var done=false;function finish(v){if(done)return;done=true;d.close();d.remove();resolve(v)}
if(kind!=='alert'){var c=document.createElement('button');c.type='button';c.className='adm-btn';c.textContent=o.cancelText||L.cancel;c.onclick=function(){finish(kind==='prompt'?null:false)};row.appendChild(c)}
var ok=document.createElement('button');ok.type='submit';ok.className='adm-btn '+(o.danger?'danger solid':'primary');ok.textContent=o.okText||(kind==='confirm'?L.yes:L.ok);row.appendChild(ok);
f.appendChild(row);d.appendChild(f);
f.addEventListener('submit',function(e){e.preventDefault();finish(kind==='prompt'?input.value:true)});
d.addEventListener('cancel',function(e){e.preventDefault();finish(kind==='alert'?true:kind==='prompt'?null:false)});
d.addEventListener('click',function(e){if(e.target===d)finish(kind==='alert'?true:kind==='prompt'?null:false)});
document.body.appendChild(d);d.showModal();(input||ok).focus();if(input)input.select()})}
window.admDialog={alert:function(m,o){return open('alert',m,o)},confirm:function(m,o){return open('confirm',m,o)},prompt:function(m,o){return open('prompt',m,o)}};
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-confirm]');if(!b||b.dataset.confirmed)return;e.preventDefault();
open('confirm',b.getAttribute('data-confirm'),{danger:b.classList.contains('danger')}).then(function(y){if(!y)return;b.dataset.confirmed='1';b.click();delete b.dataset.confirmed})});
// click a chart (or its expand button) to see it large, in a dialog; the SVG is cloned, never re-parsed from text
document.addEventListener('click',function(e){var tr=e.target.closest&&e.target.closest('[data-chart-open],[data-chart] svg');if(!tr)return;var card=tr.closest('[data-chart]');var svg=card&&card.querySelector('svg');if(!svg)return;
var d=document.createElement('dialog');d.className='adm-dialog adm-chart-dialog';d.setAttribute('aria-modal','true');
var h=card.querySelector('h2');var t=document.createElement('h2');t.textContent=h&&h.firstChild?h.firstChild.textContent:'';d.appendChild(t);
var c=svg.cloneNode(true);c.style.maxWidth='none';c.style.width='100%';c.style.height='auto';d.appendChild(c);
var row=document.createElement('div');row.className='adm-dialog-actions';var b=document.createElement('button');b.type='button';b.className='adm-btn primary';b.textContent=L.close;b.onclick=function(){d.close()};row.appendChild(b);d.appendChild(row);
d.addEventListener('click',function(ev){if(ev.target===d)d.close()});d.addEventListener('close',function(){d.remove()});document.body.appendChild(d);d.showModal();b.focus()});
// a small label that follows the pointer over a chart: the value under the cursor, no waiting for the browser's own tooltip
var tip=null;
function tipText(el){var t=el.querySelector&&el.querySelector('title');if(t){el.setAttribute('data-tip',t.textContent);t.remove()}var v=el.getAttribute('data-tip')||'';var i=v.lastIndexOf(': ');return i>=0?v.slice(i+2):v}
function tipMove(e){if(!tip)return;var w=tip.offsetWidth,h=tip.offsetHeight,x=e.clientX+14,y=e.clientY+16;if(x+w>innerWidth-4)x=e.clientX-w-10;if(y+h>innerHeight-4)y=e.clientY-h-10;tip.style.left=Math.max(4,x)+'px';tip.style.top=Math.max(4,y)+'px'}
function tipHide(){if(tip){tip.remove();tip=null}}
document.addEventListener('pointerover',function(e){var el=e.target.closest&&e.target.closest('svg .adm-hit');if(!el)return;var txt=tipText(el);if(!txt)return;tipHide();tip=document.createElement('div');tip.className='adm-tip';tip.setAttribute('role','tooltip');tip.textContent=txt;(el.closest('dialog')||document.body).appendChild(tip);tipMove(e)});
document.addEventListener('pointermove',tipMove);
document.addEventListener('pointerout',function(e){var el=e.target.closest&&e.target.closest('svg .adm-hit');if(el)tipHide()});
document.addEventListener('scroll',tipHide,true);
// a form is sent once: a second click or Enter within 8 s is swallowed and the buttons stay disabled meanwhile (G-05).
// Forms that handle their own submit (fetch) are left alone, as is data-multi (a form that may be sent again at once).
function unlock(f){delete f.dataset.sent;var bs=f.querySelectorAll('button[type=submit],input[type=submit]');for(var i=0;i<bs.length;i++)bs[i].disabled=false}
document.addEventListener('submit',function(e){var f=e.target;if(e.defaultPrevented||!f||String(f.method).toLowerCase()!=='post'||f.dataset.multi!==undefined)return;
if(f.dataset.sent&&Date.now()-Number(f.dataset.sent)<8000){e.preventDefault();return}
f.dataset.sent=String(Date.now());
var bs=f.querySelectorAll('button[type=submit],input[type=submit]');
setTimeout(function(){for(var i=0;i<bs.length;i++)bs[i].disabled=true},0);
setTimeout(function(){unlock(f)},8000)});
window.addEventListener('pageshow',function(e){if(!e.persisted)return;var fs=document.querySelectorAll('form[data-sent]');for(var i=0;i<fs.length;i++)unlock(fs[i])});
})();`;

/** Built-in (default) script, kept for pages that include it directly; `modalScript()` also applies text overrides. */
export const MODAL_SCRIPT = modalScript();
