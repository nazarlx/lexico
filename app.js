/* Lexico — vocabulary trainer with SM-2 spaced repetition.
   Storage: IndexedDB. No build step, no external requests except the Claude API. */

'use strict';

/* ======================= storage ======================= */

const DB_NAME = 'lexio';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('words')) {
        const s = d.createObjectStore('words', { keyPath: 'id' });
        s.createIndex('term', 'termKey', { unique: true });
        s.createIndex('due', 'srs.due');
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const store = {
  allWords: () => wrap(tx('words', 'readonly').getAll()),
  getWord: (id) => wrap(tx('words', 'readonly').get(id)),
  putWord: (w) => wrap(tx('words', 'readwrite').put(w)),
  delWord: (id) => wrap(tx('words', 'readwrite').delete(id)),
  byTerm: (key) => wrap(tx('words', 'readonly').index('term').get(key)),
  getMeta: async (key, fallback) => {
    const r = await wrap(tx('meta', 'readonly').get(key));
    return r === undefined ? fallback : r.value;
  },
  setMeta: (key, value) => wrap(tx('meta', 'readwrite').put({ key, value })),
  clearAll: async () => {
    await wrap(tx('words', 'readwrite').clear());
    await wrap(tx('meta', 'readwrite').clear());
  },
};

/* Bulk put inside a single transaction — much faster for imports. */
function putWords(list) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('words', 'readwrite');
    const s = t.objectStore('words');
    list.forEach((w) => s.put(w));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ======================= settings ======================= */

const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-4-8',
  lang: 'ukrainian',
  sessionMax: 90,    // cap on DUE REVIEWS per session; new words are always the full goal
  newPerDay: 30,     // daily goal, Monday–Saturday; Sunday is the recap
  sound: false,      // master switch; off by default — system voices vary wildly in quality
  autoSpeak: true,   // only applies while `sound` is on
  voiceURI: '',
};

let settings = { ...DEFAULTS };

async function loadSettings() {
  const saved = await store.getMeta('settings', {});
  settings = { ...DEFAULTS, ...saved };
}

function saveSettings() {
  return store.setMeta('settings', settings);
}

/* ======================= SM-2 ======================= */

const DAY = 86400000;

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const EASE_START = 2.3;
const EASE_MAX = 2.8;
const EASE_MIN = 1.4;

function freshSrs() {
  return { reps: 0, lapses: 0, interval: 0, ease: EASE_START, due: today(), lastGrade: null };
}

/* Binary grading: 0 = "не знаю", 1 = "знаю".
   With only two answers there is no self-rated difficulty, so the interval
   growth comes from the success streak and a slowly adapting ease factor.
   Returns a new srs object; never mutates the input. */
function schedule(srs, grade) {
  const s = { ...srs };
  s.lastGrade = grade;

  if (grade === 0) {
    s.lapses += 1;
    s.reps = 0;
    s.interval = 0;
    s.ease = Math.max(EASE_MIN, s.ease - 0.25);
    s.due = today();          // comes back in the same session
    return s;
  }

  s.reps += 1;
  s.ease = Math.min(EASE_MAX, s.ease + 0.05);

  if (s.reps === 1) s.interval = 1;
  else if (s.reps === 2) s.interval = 3;
  else s.interval = Math.round(s.interval * s.ease);

  s.interval = Math.min(s.interval, 365);
  s.due = today() + s.interval * DAY;
  return s;
}

/* What the next interval would be, for the button hint. */
function previewInterval(srs, grade) {
  if (grade === 0) return 'покажу знову';
  const n = schedule(srs, grade).interval;
  if (n <= 1) return 'через 1 день';
  if (n < 5) return 'через ' + n + ' дні';
  if (n < 30) return 'через ' + n + ' днів';
  if (n < 365) return 'через ' + Math.round(n / 30) + ' міс';
  return 'через рік';
}

/* ======================= week model ======================= */

/* Monday–Saturday are learning days; Sunday is the weekly check-up. */
const RECAP_DAY = 0;                       // JS Sunday
const isRecapDay = (d = new Date()) => d.getDay() === RECAP_DAY;

const DAY_NAMES = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const DAY_SHORT = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/* Monday 00:00 of the current week. Sunday belongs to the week that just ended. */
function weekStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() + 6) % 7;      // Mon=0 … Sun=6
  return d.getTime() - shift * DAY;
}

/* Words first learned during the current week — the Sunday recap set. */
function weekWords(all, from = weekStart()) {
  return all.filter((w) => w.introducedAt && w.introducedAt >= from);
}

function wordState(w) {
  if (w.srs.reps === 0) return 'new';
  if (w.srs.interval >= 21) return 'mature';
  return 'learning';
}

/* ======================= helpers ======================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dueLabel(ts) {
  const diff = Math.round((ts - today()) / DAY);
  if (diff <= 0) return 'сьогодні';
  if (diff === 1) return 'завтра';
  if (diff < 30) return 'через ' + diff + ' дн';
  return 'через ' + Math.round(diff / 30) + ' міс';
}

/* ======================= speech ======================= */

let voices = [];

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  const sel = $('#sVoice');
  if (!sel) return;
  sel.innerHTML = '<option value="">Системний за замовчуванням</option>' +
    voices.map((v) => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} (${v.lang})</option>`).join('');
  sel.value = settings.voiceURI || '';
}

/* Single choke point for all audio: nothing speaks while `sound` is off. */
function speak(text) {
  if (!settings.sound || !('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.92;
  const v = voices.find((x) => x.voiceURI === settings.voiceURI);
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

/* ======================= Claude API ======================= */

const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    term: { type: 'string', description: 'the English word or phrase, lowercased unless a proper noun' },
    translation: { type: 'string', description: 'translation into the target language; 1-3 comma-separated variants' },
    ipa: { type: 'string', description: 'IPA transcription wrapped in slashes, e.g. /rɪˈzɪliənt/' },
    pos: { type: 'string', description: 'part of speech in English, e.g. noun, verb, adjective' },
    example: { type: 'string', description: 'one natural English sentence using the word' },
    exampleTranslation: { type: 'string', description: 'translation of the example sentence' },
    level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
    tags: { type: 'array', items: { type: 'string' }, description: '1-3 topic tags in the target language' },
  },
  required: ['term', 'translation', 'ipa', 'pos', 'example', 'exampleTranslation', 'level', 'tags'],
  additionalProperties: false,
};

const BATCH_SCHEMA = {
  type: 'object',
  properties: { words: { type: 'array', items: ENRICH_SCHEMA } },
  required: ['words'],
  additionalProperties: false,
};

async function callClaude(userText, schema) {
  if (!settings.apiKey) throw new Error('Спочатку додай API-ключ у Налаштуваннях.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 4096,
      system:
        `You build vocabulary flashcards for a learner of English whose native language is ` +
        `${settings.lang}. Translations, example translations and tags must be written in ` +
        `${settings.lang}. Keep example sentences short, natural and concrete — they should make ` +
        `the meaning obvious from context. Choose the most common sense of the word.`,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: userText }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch { /* non-JSON error body */ }
    if (res.status === 401) throw new Error('Невірний API-ключ.');
    if (res.status === 429) throw new Error('Перевищено ліміт запитів. Спробуй за хвилину.');
    throw new Error(`Помилка API (${res.status}). ${detail}`.trim());
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Модель відмовилася обробити цей запит.');
  if (data.stop_reason === 'max_tokens') throw new Error('Відповідь обрізано — спробуй меншу порцію слів.');

  const text = (data.content || []).find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Порожня відповідь від моделі.');
  return JSON.parse(text);
}

const enrichOne = (term) =>
  callClaude(`Build a flashcard for the English word: "${term}"`, ENRICH_SCHEMA);

const enrichMany = (pairs) =>
  callClaude(
    'Build a flashcard for each of these English words. Where a translation is already ' +
    'supplied after the dash, keep its meaning and only refine the wording if it is wrong.\n\n' +
    pairs.map((p) => (p.translation ? `${p.term} — ${p.translation}` : p.term)).join('\n'),
    BATCH_SCHEMA
  );

/* ======================= navigation ======================= */

let currentView = 'review';

function nav(view) {
  currentView = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
  $$('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  window.scrollTo(0, 0);
  if (view === 'review') startOrResumeReview();
  if (view === 'words') renderWords();
  if (view === 'stats') renderStats();
  if (view === 'settings') fillSettingsForm();
}

/* ======================= review session ======================= */

const session = {
  queue: [],        // words still to answer this session
  total: 0,
  answered: 0,
  correct: 0,
  current: null,
  mode: 'flip',     // flip | choice | type
  revealed: false,
  allWords: [],     // snapshot for building distractors
  isRecap: false,   // Sunday week check-up
  forgot: [],       // words answered "не знаю" this session
};

function pickMode(w) {
  const r = w.srs.reps;
  if (r === 0) return 'flip';
  if (r < 3) return Math.random() < 0.5 ? 'flip' : 'choice';
  return Math.random() < 0.6 ? 'type' : 'choice';
}

const MODE_LABEL = { flip: 'Картка', choice: 'Вибір варіанта', type: 'Введення слова' };

/* Everything the Today screen needs to describe the day. */
async function todayPlan() {
  const all = await store.allWords();
  const t = today();
  const recap = isRecapDay();

  const due = all.filter((w) => w.srs.reps > 0 && w.srs.due <= t);
  const newPool = all
    .filter((w) => w.srs.reps === 0)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.created - b.created);

  const introducedToday = await store.getMeta('introduced:' + t, 0);
  const goal = settings.newPerDay;
  const newBudget = recap ? 0 : Math.max(0, goal - introducedToday);
  const week = weekWords(all);

  return {
    all, recap, due, newPool, week,
    goal,
    introducedToday,
    newPlanned: Math.min(newBudget, newPool.length),
    dueCount: due.length,
    weekCount: week.length,
  };
}

async function buildQueue({ ahead = false } = {}) {
  const plan = await todayPlan();
  session.allWords = plan.all;
  session.isRecap = false;

  // Sunday: no new words — re-check everything learned Monday to Saturday.
  if (plan.recap && plan.week.length) {
    session.isRecap = true;
    return shuffle(plan.week.slice());
  }

  // The daily goal is a promise: new words are never squeezed out. `sessionMax`
  // caps only the due reviews, so a big goal can't starve the repetitions.
  const fresh = plan.newPool.slice(0, plan.newPlanned);
  const due = shuffle(plan.due.slice()).slice(0, settings.sessionMax);

  const queue = shuffle([...due, ...fresh]);

  if (ahead && queue.length === 0) {
    return shuffle(plan.all.filter((w) => w.srs.reps > 0)).slice(0, settings.sessionMax);
  }
  return queue;
}

/* Entry point for the Today tab: resume a session, or show the day's plan. */
async function startOrResumeReview() {
  await refreshDueBadge();
  if (session.queue.length && session.current) { show('session'); renderCard(); return; }

  const plan = await todayPlan();
  if (!plan.all.length) { renderEmptyState(0); show('empty'); return; }

  await renderPlan(plan);
  show('plan');
}

async function beginSession() {
  const queue = await buildQueue();
  if (!queue.length) {
    renderEmptyState((await store.allWords()).length);
    show('empty');
    return;
  }
  session.queue = queue;
  session.total = queue.length;
  session.answered = 0;
  session.correct = 0;
  session.forgot = [];
  nextCard();
}

/* The daily plan card: what today asks of you, and how much is already done. */
async function renderPlan(plan) {
  const d = new Date();
  $('#planDay').textContent =
    `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'][d.getMonth()]}`;

  const rows = [];
  let doneUnits = 0, totalUnits = 0;

  if (plan.recap) {
    $('#planTitle').textContent = 'Підсумок тижня';
    rows.push(['📖', 'Слів вивчено за тиждень', plan.weekCount]);
    rows.push(['🔁', 'Перевіримо всі', plan.weekCount]);
    totalUnits = plan.weekCount;
    doneUnits = 0;
    $('#planNote').textContent = plan.weekCount
      ? 'Сьогодні нових слів немає. Перевіряємо, що залишилось у памʼяті з понеділка по суботу.'
      : 'Цього тижня нових слів ще не було. Повертайся в понеділок або повтори наперед.';
    $('#btnStartToday').textContent = 'Перевірити тиждень';
    $('#btnStartToday').disabled = plan.weekCount === 0;
  } else {
    $('#planTitle').textContent = 'План на сьогодні';
    rows.push(['✨', 'Нові слова', `${plan.introducedToday} / ${plan.goal}`]);
    rows.push(['🔁', 'Повторення', plan.dueCount]);
    totalUnits = plan.goal + plan.dueCount + plan.introducedToday;
    doneUnits = plan.introducedToday;
    const dueNow = Math.min(plan.dueCount, settings.sessionMax);
    const left = plan.newPlanned + dueNow;
    $('#planNote').textContent = left
      ? `Карток у сесії: ${left} — ${plan.newPlanned} нових і ${dueNow} на повторення.`
      : 'Денну норму виконано. Можна повторити наперед або просто відпочити.';
    $('#btnStartToday').textContent = left ? 'Почати' : 'Повторити наперед';
    $('#btnStartToday').disabled = false;
  }

  // the goal picker only makes sense on learning days
  $('#goalPicker').classList.toggle('hidden', plan.recap);
  $$('#goalPicker .goal-opt').forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.goal) === settings.newPerDay));

  $('#planRows').innerHTML = rows.map(([icon, label, val]) =>
    `<div class="plan-row"><span class="plan-ico">${icon}</span>
       <span class="plan-lbl">${escapeHtml(label)}</span>
       <b class="plan-val">${escapeHtml(String(val))}</b></div>`).join('');

  const pct = totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0;
  $('#planPct').textContent = pct + '%';
  $('#planRing').style.setProperty('--pct', pct);

  await renderWeekStrip(plan);
}

/* Mon–Sat progress strip plus the Sunday slot. */
async function renderWeekStrip(plan) {
  const start = weekStart();
  const todayTs = today();

  const counts = [];
  for (let i = 0; i < 7; i++) counts.push(await store.getMeta('introduced:' + (start + i * DAY), 0));

  // Days before the first day you studied aren't misses — you simply weren't here yet.
  const firstActive = counts.findIndex((c) => c > 0);

  const cells = counts.map((count, i) => {
    const ts = start + i * DAY;                  // Mon … Sun
    const isToday = ts === todayTs;
    const isSunday = i === 6;
    const missed = firstActive !== -1 && i > firstActive && ts < todayTs && count === 0;
    const state = isSunday ? 'rest'
      : count >= settings.newPerDay ? 'full'
      : count > 0 ? 'part'
      : missed ? 'miss' : 'idle';
    return `<div class="week-cell ${state}${isToday ? ' today' : ''}">
        <span class="week-d">${DAY_SHORT[(i + 1) % 7]}</span>
        <span class="week-n">${isSunday ? '✓' : count}</span>
      </div>`;
  });
  $('#weekGrid').innerHTML = cells.join('');

  const learned = plan.weekCount;
  const mature = plan.week.filter((w) => w.srs.reps >= 2 && w.srs.lastGrade === 1).length;
  $('#weekSummary').textContent = learned
    ? `Вивчено цього тижня: ${learned} ${plural(learned, 'слово', 'слова', 'слів')}, упевнено памʼятаєш ${mature}.`
    : 'Цього тижня нових слів ще не було.';
  $('#weekCard').classList.toggle('hidden', false);
}

/* An empty dictionary and a finished day are different situations and need
   different offers — the first-run screen must lead straight to getting words. */
function renderEmptyState(total) {
  const firstRun = total === 0;
  $('#emptyIcon').textContent = firstRun ? '📚' : '✅';
  $('#emptyTitle').textContent = firstRun ? 'Починаємо' : 'На сьогодні все';
  $('#emptyHint').textContent = firstRun
    ? 'У словнику поки порожньо. Візьми готовий набір найчастотніших слів або додай свої.'
    : 'Повторень немає. Додай нові слова або повертайся завтра.';
  $('#btnQuickSeed').classList.toggle('hidden', !firstRun);
  $('#btnEmptyAdd').classList.toggle('hidden', false);
  $('#btnEmptyAdd').textContent = firstRun ? 'Додати свої слова' : 'Додати слова';
  $('#btnEmptyAdd').classList.toggle('primary', !firstRun);
  $('#btnEmptyAdd').classList.toggle('ghost', firstRun);
  $('#btnStudyAhead').classList.toggle('hidden', firstRun);
  $('#quickSeedNote').textContent = firstRun
    ? 'Слова додаються за частотністю, а в день показується лише стільки нових, скільки ти задав у налаштуваннях.'
    : '';
}

/* One-tap first run: grab the 1000 most frequent words and start studying. */
async function quickSeed() {
  const btn = $('#btnQuickSeed');
  btn.disabled = true;
  btn.textContent = 'Завантаження…';
  try {
    $('#seedCount').value = '1000';
    $('#seedLevel').value = 'all';
    await loadSeedPack();
    await startOrResumeReview();
    await beginSession();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Завантажити 1000 слів';
  }
}

function show(which) {
  $('#reviewEmpty').classList.toggle('hidden', which !== 'empty');
  $('#todayPlan').classList.toggle('hidden', which !== 'plan');
  $('#reviewSession').classList.toggle('hidden', which !== 'session');
  $('#sessionDone').classList.toggle('hidden', which !== 'done');
}

function nextCard() {
  if (!session.queue.length) return finishSession();
  session.current = session.queue[0];
  session.mode = pickMode(session.current);
  session.revealed = false;
  show('session');
  renderCard();
}

function renderCard() {
  const w = session.current;
  if (!w) return;

  const pct = session.total ? (session.answered / session.total) * 100 : 0;
  $('#progressFill').style.width = pct + '%';
  $('#progressCount').textContent = `${session.answered} / ${session.total}`;
  $('#sessionModeLabel').textContent = MODE_LABEL[session.mode];

  $('#cardPos').textContent = w.pos || '';
  const fc = $('#flashcard');
  fc.classList.remove('flipped');
  // restart the entry animation so each card visibly arrives
  fc.classList.remove('enter');
  void fc.offsetWidth;
  fc.classList.add('enter');
  $('#choices').classList.add('hidden');
  $('#typing').classList.add('hidden');
  $('#grades').classList.add('hidden');
  $('#btnShow').classList.add('hidden');
  $('#btnCheck').classList.add('hidden');
  $('#btnNext').classList.add('hidden');
  $('#typeFeedback').innerHTML = '';

  // the card itself is only clickable in flip mode
  $('#flashcard').style.cursor = session.mode === 'flip' ? 'pointer' : 'default';
  $('#flipHint').textContent = session.mode === 'flip' ? 'Натисни, щоб побачити переклад' : '';

  if (session.mode === 'type') {
    // Ukrainian → English: prompt is the translation, answer is typed.
    $('#cardPrompt').textContent = w.translation;
    $('#cardIpa').textContent = '';
    $('#btnSpeak').classList.add('hidden');
    const input = $('#typeInput');
    input.value = '';
    input.disabled = false;
    $('#typing').classList.remove('hidden');
    $('#btnCheck').classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
  } else {
    $('#cardPrompt').textContent = w.term;
    $('#cardIpa').textContent = w.ipa || '';
    $('#btnSpeak').classList.remove('hidden');
    if (settings.sound && settings.autoSpeak) speak(w.term);

    if (session.mode === 'choice') {
      renderChoices(w);
      $('#choices').classList.remove('hidden');
    } else {
      $('#btnShow').classList.remove('hidden');
    }
  }
}

function renderChoices(w) {
  const pool = session.allWords.filter((x) => x.id !== w.id && x.translation);
  const distractors = shuffle(pool).slice(0, 3).map((x) => x.translation);
  const options = shuffle([w.translation, ...distractors]);
  $('#choices').innerHTML = options
    .map((o, i) => `<button class="choice" data-choice="${escapeHtml(o)}">
        <span class="choice-badge">${'ABCD'[i]}</span>
        <span>${escapeHtml(o)}</span>
      </button>`)
    .join('');
}

function revealAnswer() {
  const w = session.current;
  $('#answerMain').textContent = session.mode === 'type' ? w.term : w.translation;
  // the back face repeats the prompt word, so the pair stays readable after the flip
  $('#answerTerm').textContent = session.mode === 'type' ? w.translation : w.term;
  let ex = '';
  if (w.example) {
    ex = escapeHtml(w.example);
    if (w.exampleTranslation) ex += `<i>${escapeHtml(w.exampleTranslation)}</i>`;
  }
  $('#answerExample').innerHTML = ex;
  $('#flashcard').classList.add('flipped');
  session.revealed = true;
}

function showGrades() {
  $('#gGood').textContent = previewInterval(session.current.srs, 1);
  $('#btnShow').classList.add('hidden');
  $('#btnCheck').classList.add('hidden');
  $('#grades').classList.remove('hidden');
}

async function applyGrade(grade) {
  const w = session.current;
  const wasNew = w.srs.reps === 0;
  const firstTry = !session.forgot.includes(w.term);

  w.srs = schedule(w.srs, grade);
  w.lastReviewedAt = Date.now();
  if (wasNew && grade === 1) w.introducedAt = Date.now();
  await store.putWord(w);

  if (wasNew && grade === 1) {
    const key = 'introduced:' + today();
    await store.setMeta(key, (await store.getMeta(key, 0)) + 1);
  }

  session.queue.shift();
  if (grade === 0) {
    if (firstTry) session.forgot.push(w.term);
    // Re-insert a few cards later so it comes back within this session.
    const pos = Math.min(session.queue.length, 3);
    session.queue.splice(pos, 0, w);
  } else {
    session.answered += 1;
    if (firstTry) session.correct += 1;
  }

  await bumpAccuracy(grade === 1 && firstTry);
  nextCard();
}

async function bumpAccuracy(wasCorrect) {
  const a = await store.getMeta('accuracy', { right: 0, total: 0 });
  a.total += 1;
  if (wasCorrect) a.right += 1;
  await store.setMeta('accuracy', a);
}

async function finishSession() {
  session.current = null;
  const pct = session.total ? Math.round((session.correct / session.total) * 100) : 0;
  await touchStreak();

  const streak = await store.getMeta('streak', { last: 0, count: 0 });
  const recap = session.isRecap;

  $('#doneIcon').textContent = recap ? '🏁' : '🎉';
  $('#doneTitle').textContent = recap ? 'Підсумок тижня' : 'Сесію завершено';
  $('#doneTotalLbl').textContent = recap ? 'слів за тиждень' : 'карток';
  $('#doneTotal').textContent = session.total;
  $('#doneAcc').textContent = pct + '%';
  $('#doneStreak').textContent = streak.count;

  // the forgotten words are the actionable part of a summary
  const forgot = session.forgot;
  $('#forgotBox').classList.toggle('hidden', forgot.length === 0);
  $('#forgotList').innerHTML = forgot.slice(0, 40)
    .map((t) => `<span class="forgot-chip">${escapeHtml(t)}</span>`).join('');

  const all = await store.allWords();
  const nextDue = all.filter((w) => w.srs.due > today()).map((w) => w.srs.due).sort((a, b) => a - b)[0];

  if (recap) {
    $('#doneStats').textContent = forgot.length
      ? `${session.correct} з ${session.total} памʼятаєш упевнено. Решту повторимо найближчими днями.`
      : 'Весь тиждень засвоєно повністю. Новий цикл — у понеділок.';
  } else {
    $('#doneStats').textContent = nextDue
      ? `Наступне повторення — ${dueLabel(nextDue)}.`
      : 'Додай нові слова, щоб продовжити.';
  }

  await refreshDueBadge();
  show('done');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ======================= streak ======================= */

async function touchStreak() {
  const t = today();
  const data = await store.getMeta('streak', { last: 0, count: 0 });
  if (data.last === t) return;
  data.count = data.last === t - DAY ? data.count + 1 : 1;
  data.last = t;
  await store.setMeta('streak', data);
  renderStreak(data.count);
}

async function renderStreakFromStore() {
  const data = await store.getMeta('streak', { last: 0, count: 0 });
  const t = today();
  const alive = data.last === t || data.last === t - DAY;
  renderStreak(alive ? data.count : 0);
}

function renderStreak(n) {
  $('#streakVal').textContent = n;
  $('#streakBadge').classList.toggle('hidden', n === 0);
}

async function refreshDueBadge() {
  const all = await store.allWords();
  const t = today();
  const due = all.filter((w) => w.srs.due <= t).length;
  const badge = $('#navDue');
  badge.textContent = due > 99 ? '99+' : due;
  badge.classList.toggle('hidden', due === 0);
}

/* ======================= words view ======================= */

async function renderWords() {
  const all = await store.allWords();
  const q = normalize($('#wordSearch').value || '');
  const filter = $('#wordFilter').value;
  const t = today();

  let list = all;
  if (q) list = list.filter((w) => w.termKey.includes(q) || normalize(w.translation).includes(q));
  if (filter === 'due') list = list.filter((w) => w.srs.due <= t);
  else if (filter !== 'all') list = list.filter((w) => wordState(w) === filter);

  list.sort((a, b) => a.srs.due - b.srs.due || a.termKey.localeCompare(b.termKey));

  const container = $('#wordList');
  $('#wordCount').textContent = list.length
    ? `${list.length} ${plural(list.length, 'слово', 'слова', 'слів')}`
    : '';

  if (!list.length) {
    container.innerHTML = all.length
      ? `<div class="empty"><div class="empty-icon">🔍</div><h2>Нічого не знайдено</h2>
           <p>Спробуй інший запит або зміни фільтр.</p></div>`
      : `<div class="empty"><div class="empty-icon">📚</div><h2>Словник порожній</h2>
           <p>Додай слова вручну або візьми готовий набір.</p>
           <div class="empty-actions"><button class="btn primary" data-nav="add">Додати слова</button></div></div>`;
    return;
  }

  const stateLabel = { new: 'нове', learning: 'вчиться', mature: 'вивчене' };
  container.innerHTML = list.map((w) => {
    const st = wordState(w);
    return `<div class="word" data-id="${w.id}">
      <div class="word-term">${escapeHtml(w.term)}${w.ipa ? `<span class="ipa">${escapeHtml(w.ipa)}</span>` : ''}</div>
      <div class="word-tr">${escapeHtml(w.translation)}</div>
      <div class="word-meta">
        <div>
          <div class="word-state state-${st}">${stateLabel[st]}</div>
          <div class="word-due">${dueLabel(w.srs.due)}</div>
        </div>
        <button class="icon-btn" data-speak="${escapeHtml(w.term)}" title="Озвучити">🔊</button>
        <button class="icon-btn" data-del="${w.id}" title="Видалити">✕</button>
      </div>
    </div>`;
  }).join('');
}

/* ======================= stats view ======================= */

async function renderStats() {
  const all = await store.allWords();
  const t = today();
  const counts = { new: 0, learning: 0, mature: 0 };
  all.forEach((w) => counts[wordState(w)]++);

  $('#stTotal').textContent = all.length;
  $('#stDue').textContent = all.filter((w) => w.srs.due <= t).length;
  $('#stNew').textContent = counts.new;
  $('#stMature').textContent = counts.mature;

  const streak = await store.getMeta('streak', { last: 0, count: 0 });
  const alive = streak.last === t || streak.last === t - DAY;
  $('#stStreak').textContent = alive ? streak.count : 0;

  const acc = await store.getMeta('accuracy', { right: 0, total: 0 });
  $('#stAccuracy').textContent = acc.total ? Math.round((acc.right / acc.total) * 100) + '%' : '—';

  // 14-day forecast
  const buckets = new Array(14).fill(0);
  all.forEach((w) => {
    const d = Math.round((w.srs.due - t) / DAY);
    if (d <= 0) buckets[0]++;
    else if (d < 14) buckets[d]++;
  });
  const peak = Math.max(1, ...buckets);
  const names = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  $('#forecast').innerHTML = buckets.map((n, i) => {
    const d = new Date(t + i * DAY);
    const label = i === 0 ? 'сьог' : names[d.getDay()];
    return `<div class="fc-col" data-count="${n}" title="${n}">
      <div class="fc-bar" style="height:${Math.round((n / peak) * 100)}%"></div>
      <div class="fc-lbl">${label}</div>
    </div>`;
  }).join('');

  // levels
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const byLevel = levels.map((l) => all.filter((w) => w.level === l).length);
  const lvlPeak = Math.max(1, ...byLevel);
  $('#levels').innerHTML = levels.map((l, i) => `<div class="lvl-row">
      <span>${l}</span>
      <div class="lvl-track"><div class="lvl-fill" style="width:${(byLevel[i] / lvlPeak) * 100}%"></div></div>
      <span class="lvl-num">${byLevel[i]}</span>
    </div>`).join('');
}

/* ======================= add words ======================= */

/* `order` decides which new words enter the queue first: 0 for words the user
   added by hand, then frequency rank for starter-pack words. */
function makeWord(fields) {
  return {
    id: uid(),
    order: fields.order || 0,
    term: fields.term.trim(),
    termKey: normalize(fields.term),
    translation: (fields.translation || '').trim(),
    ipa: (fields.ipa || '').trim(),
    pos: (fields.pos || '').trim(),
    example: (fields.example || '').trim(),
    exampleTranslation: (fields.exampleTranslation || '').trim(),
    tags: fields.tags || [],
    level: fields.level || '',
    created: Date.now(),
    srs: freshSrs(),
  };
}

/* Adds a word, or merges into the existing one if the term is already there.
   Returns 'added' | 'merged'. */
async function upsertWord(fields) {
  const key = normalize(fields.term);
  const existing = await store.byTerm(key);
  if (existing) {
    const merged = { ...existing };
    ['translation', 'ipa', 'pos', 'example', 'exampleTranslation', 'level'].forEach((f) => {
      if (!merged[f] && fields[f]) merged[f] = String(fields[f]).trim();
    });
    if ((!merged.tags || !merged.tags.length) && fields.tags) merged.tags = fields.tags;
    await store.putWord(merged);
    return 'merged';
  }
  await store.putWord(makeWord(fields));
  return 'added';
}

function readAddForm() {
  return {
    term: $('#fTerm').value,
    translation: $('#fTranslation').value,
    ipa: $('#fIpa').value,
    pos: $('#fPos').value,
    example: $('#fExample').value,
    exampleTranslation: $('#fExampleTr').value,
    level: $('#fLevel').value,
    tags: $('#fTags').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function fillAddForm(d) {
  $('#fTerm').value = d.term || $('#fTerm').value;
  $('#fTranslation').value = d.translation || '';
  $('#fIpa').value = d.ipa || '';
  $('#fPos').value = d.pos || '';
  $('#fExample').value = d.example || '';
  $('#fExampleTr').value = d.exampleTranslation || '';
  $('#fLevel').value = d.level || '';
  $('#fTags').value = (d.tags || []).join(', ');
}

function clearAddForm() {
  $('#addOneForm').reset();
  $('#aiStatus').textContent = '';
}

/* Splits "word — translation" lines. Translation is optional. */
function parseBulk(text) {
  return text.split('\n').map((line) => {
    const m = line.match(/^\s*(.+?)\s*(?:[—–\-=]|\t)\s*(.*)\s*$/);
    if (m) return { term: m[1], translation: m[2] };
    const t = line.trim();
    return t ? { term: t, translation: '' } : null;
  }).filter((p) => p && p.term);
}

/* ======================= starter pack ======================= */

let seedCache = null;

async function loadSeedPack() {
  const btn = $('#btnSeedLoad');
  const status = $('#seedStatus');
  status.classList.remove('err');
  btn.disabled = true;

  try {
    if (!seedCache) {
      status.textContent = 'Завантаження набору…';
      const res = await fetch('seed.json');
      if (!res.ok) throw new Error('Файл seed.json не знайдено поруч з додатком.');
      seedCache = await res.json();
    }

    const levels = $('#seedLevel').value;
    const allowed = levels === 'all' ? null : new Set(levels.split(','));
    const limit = Number($('#seedCount').value) || Infinity;

    // seed.json is already sorted by frequency, so slicing keeps the best words
    let picked = allowed ? seedCache.filter((d) => allowed.has(d.level)) : seedCache.slice();
    picked = picked.slice(0, limit);

    status.textContent = 'Перевірка дублікатів…';
    const existing = new Set((await store.allWords()).map((w) => w.termKey));

    const fresh = [];
    let skipped = 0;
    picked.forEach((d, i) => {
      const key = normalize(d.term);
      if (existing.has(key)) { skipped++; return; }
      existing.add(key);
      // order starts at 1 so hand-added words (order 0) always come first
      fresh.push(makeWord({ ...d, order: i + 1 }));
    });

    // Write in chunks so a huge pack does not block the UI in one transaction.
    const CHUNK = 500;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      status.textContent = `Збереження ${Math.min(i + CHUNK, fresh.length)} / ${fresh.length}…`;
      await putWords(fresh.slice(i, i + CHUNK));
    }

    status.textContent = '';
    toast(`Додано ${fresh.length}${skipped ? `, вже були: ${skipped}` : ''}`);
    await refreshDueBadge();
  } catch (e) {
    status.classList.add('err');
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ======================= export / import ======================= */

async function exportJson() {
  const words = await store.allWords();
  const payload = {
    app: 'lexio', version: 1, exportedAt: new Date().toISOString(),
    settings: { ...settings, apiKey: '' },   // never export the key
    words,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lexio-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Експортовано ${words.length} ${plural(words.length, 'слово', 'слова', 'слів')}`);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.words)) throw new Error('Невідомий формат файлу.');
    let added = 0;
    for (const w of data.words) {
      if (!w.term) continue;
      const existing = await store.byTerm(normalize(w.term));
      if (existing) continue;
      await store.putWord({
        ...makeWord(w),
        srs: w.srs && typeof w.srs.due === 'number' ? w.srs : freshSrs(),
      });
      added++;
    }
    toast(`Імпортовано ${added} ${plural(added, 'слово', 'слова', 'слів')}`);
    await refreshDueBadge();
  } catch (e) {
    toast(e.message || 'Не вдалося прочитати файл', true);
  }
}

/* ======================= settings form ======================= */

function fillSettingsForm() {
  $('#sApiKey').value = settings.apiKey;
  $('#sModel').value = settings.model;
  $('#sLang').value = settings.lang;
  $('#sSessionMax').value = settings.sessionMax;
  $('#sNewPerDay').value = settings.newPerDay;
  $('#sSound').checked = settings.sound;
  $('#sAutoSpeak').checked = settings.autoSpeak;
  loadVoices();
  applySoundState();
}

/* Hides every speaker button and stops anything mid-sentence when sound is off. */
function applySoundState() {
  document.body.classList.toggle('no-sound', !settings.sound);
  $$('.sound-dependent').forEach((el) => { el.disabled = !settings.sound; });
  if (!settings.sound && 'speechSynthesis' in window) speechSynthesis.cancel();
}

function flash(id) {
  const el = $(id);
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 1800);
}

/* ======================= event wiring ======================= */

function wire() {
  // nav
  document.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-nav]');
    if (navBtn) nav(navBtn.dataset.nav);
  });

  // review
  $('#btnShow').addEventListener('click', () => { revealAnswer(); showGrades(); });

  // tapping the card flips it, the way Quizlet behaves
  $('#flashcard').addEventListener('click', (e) => {
    if (e.target.closest('#btnSpeak')) return;      // speaker button is not a flip
    if (session.mode !== 'flip' || session.revealed || !session.current) return;
    revealAnswer();
    showGrades();
  });

  $('#btnSpeak').addEventListener('click', () => speak(session.current?.term));
  $('#btnDoneOk').addEventListener('click', () => startOrResumeReview());
  $('#btnQuickSeed').addEventListener('click', quickSeed);
  $('#btnStartToday').addEventListener('click', beginSession);

  // changing the daily goal applies immediately, no Save button involved
  $('#goalPicker').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-goal]');
    if (!b) return;
    settings.newPerDay = Number(b.dataset.goal);
    await saveSettings();
    await renderPlan(await todayPlan());
    toast(`Норма: ${settings.newPerDay} ${plural(settings.newPerDay, 'слово', 'слова', 'слів')} на день`);
  });
  $('#btnDoneMore').addEventListener('click', () => $('#btnStudyAhead').click());
  $('#btnStudyAhead').addEventListener('click', async () => {
    const q = await buildQueue({ ahead: true });
    if (!q.length) return toast('Немає що повторювати наперед');
    session.queue = q; session.total = q.length;
    session.answered = 0; session.correct = 0;
    session.forgot = []; session.isRecap = false;
    nextCard();
  });

  $('#grades').addEventListener('click', (e) => {
    const b = e.target.closest('[data-grade]');
    if (b) applyGrade(Number(b.dataset.grade));
  });

  $('#choices').addEventListener('click', (e) => {
    const b = e.target.closest('.choice');
    if (!b || session.revealed) return;
    const picked = b.dataset.choice;
    const correct = picked === session.current.translation;
    $$('#choices .choice').forEach((c) => {
      c.disabled = true;
      if (c.dataset.choice === session.current.translation) c.classList.add('correct');
      else if (c === b) c.classList.add('wrong');
    });
    revealAnswer();
    if (correct) showGrades();
    else {
      // A wrong pick is a lapse — no point offering "easy".
      $('#btnNext').classList.remove('hidden');
    }
  });

  $('#btnNext').addEventListener('click', () => applyGrade(0));

  $('#btnCheck').addEventListener('click', checkTyped);
  $('#typeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); checkTyped(); }
  });

  // keyboard shortcuts during review
  document.addEventListener('keydown', (e) => {
    if (currentView !== 'review' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space' && !$('#btnShow').classList.contains('hidden')) {
      e.preventDefault(); revealAnswer(); showGrades(); return;
    }
    if (!$('#grades').classList.contains('hidden') && (e.key === '1' || e.key === '2')) {
      applyGrade(Number(e.key) - 1);
    }
  });

  // words
  $('#wordSearch').addEventListener('input', renderWords);
  $('#wordFilter').addEventListener('change', renderWords);
  $('#wordList').addEventListener('click', async (e) => {
    const sp = e.target.closest('[data-speak]');
    if (sp) return speak(sp.dataset.speak);
    const del = e.target.closest('[data-del]');
    if (del && confirm('Видалити це слово?')) {
      await store.delWord(del.dataset.del);
      await renderWords();
      await refreshDueBadge();
    }
  });

  // add — tabs
  $$('[data-addtab]').forEach((t) => t.addEventListener('click', () => {
    $$('[data-addtab]').forEach((x) => x.classList.toggle('active', x === t));
    $$('[data-addpane]').forEach((p) => p.classList.toggle('hidden', p.dataset.addpane !== t.dataset.addtab));
  }));

  // add — AI autofill
  $('#btnAutofill').addEventListener('click', async () => {
    const term = $('#fTerm').value.trim();
    if (!term) return toast('Спочатку введи слово', true);
    const status = $('#aiStatus');
    status.classList.remove('err');
    status.textContent = 'Claude заповнює картку…';
    $('#btnAutofill').disabled = true;
    try {
      fillAddForm(await enrichOne(term));
      status.textContent = 'Готово — перевір і збережи.';
    } catch (err) {
      status.classList.add('err');
      status.textContent = err.message;
    } finally {
      $('#btnAutofill').disabled = false;
    }
  });

  // add — single word
  $('#addOneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = readAddForm();
    const result = await upsertWord(fields);
    toast(result === 'merged' ? 'Слово вже було — доповнено' : 'Слово додано');
    clearAddForm();
    $('#fTerm').focus();
    await refreshDueBadge();
  });

  // add — bulk
  $('#btnBulkImport').addEventListener('click', async () => {
    const pairs = parseBulk($('#bulkInput').value);
    if (!pairs.length) return toast('Нічого не розпізнано', true);

    const status = $('#bulkStatus');
    status.classList.remove('err');
    const btn = $('#btnBulkImport');
    btn.disabled = true;

    try {
      let records = pairs;
      if ($('#bulkAi').checked) {
        const CHUNK = 15;
        const enriched = [];
        for (let i = 0; i < pairs.length; i += CHUNK) {
          const slice = pairs.slice(i, i + CHUNK);
          status.textContent = `Claude обробляє ${i + 1}–${Math.min(i + CHUNK, pairs.length)} з ${pairs.length}…`;
          const res = await enrichMany(slice);
          enriched.push(...(res.words || []));
        }
        // Keep the user's own term spelling as the anchor.
        records = pairs.map((p) => {
          const hit = enriched.find((e) => normalize(e.term) === normalize(p.term));
          return hit ? { ...hit, term: p.term, translation: p.translation || hit.translation } : p;
        });
      }

      status.textContent = 'Збереження…';
      const existing = new Set((await store.allWords()).map((w) => w.termKey));
      const fresh = [];
      let skipped = 0;
      for (const r of records) {
        const key = normalize(r.term);
        if (existing.has(key)) { skipped++; continue; }
        existing.add(key);
        fresh.push(makeWord(r));
      }
      await putWords(fresh);

      status.textContent = '';
      $('#bulkInput').value = '';
      toast(`Додано ${fresh.length}${skipped ? `, пропущено дублікатів: ${skipped}` : ''}`);
      await refreshDueBadge();
    } catch (err) {
      status.classList.add('err');
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // add — starter pack
  $('#btnSeedLoad').addEventListener('click', loadSeedPack);

  // settings
  $('#btnSaveSettings').addEventListener('click', async () => {
    settings.apiKey = $('#sApiKey').value.trim();
    settings.model = $('#sModel').value.trim() || DEFAULTS.model;
    settings.lang = $('#sLang').value.trim() || DEFAULTS.lang;
    await saveSettings();
    flash('#settingsSaved');
  });

  $('#btnSaveStudy').addEventListener('click', async () => {
    settings.sessionMax = Math.max(5, Number($('#sSessionMax').value) || DEFAULTS.sessionMax);
    settings.newPerDay = Math.max(0, Number($('#sNewPerDay').value) || 0);
    settings.sound = $('#sSound').checked;
    settings.autoSpeak = $('#sAutoSpeak').checked;
    settings.voiceURI = $('#sVoice').value;
    await saveSettings();
    applySoundState();
    flash('#studySaved');
  });

  // the master switch takes effect immediately, without pressing Save
  $('#sSound').addEventListener('change', async () => {
    settings.sound = $('#sSound').checked;
    await saveSettings();
    applySoundState();
    toast(settings.sound ? 'Звук увімкнено' : 'Звук вимкнено');
  });

  $('#btnExport').addEventListener('click', exportJson);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importJson(f);
    e.target.value = '';
  });
  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('Видалити всі слова, прогрес і налаштування? Це не можна скасувати.')) return;
    await store.clearAll();
    settings = { ...DEFAULTS };
    session.queue = []; session.current = null;
    toast('Усі дані видалено');
    renderStreak(0);
    nav('review');
  });

  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = loadVoices;
}

function checkTyped() {
  if (session.revealed) return;
  const w = session.current;
  const typed = normalize($('#typeInput').value);
  if (!typed) return;

  const expected = w.termKey;
  const exact = typed === expected;
  const close = !exact && levenshtein(typed, expected) <= (expected.length > 6 ? 2 : 1);

  $('#typeInput').disabled = true;
  const fb = $('#typeFeedback');
  if (exact) fb.innerHTML = '<span class="ok">Правильно</span>';
  else if (close) fb.innerHTML = `<span class="ok">Майже</span><span class="expected">${escapeHtml(w.term)}</span>`;
  else fb.innerHTML = `<span class="bad">Не те</span><span class="expected">${escapeHtml(w.term)}</span>`;

  revealAnswer();
  if (settings.autoSpeak) speak(w.term);

  if (exact || close) showGrades();
  else $('#btnNext').classList.remove('hidden');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/* ======================= boot ======================= */

(async function init() {
  try {
    db = await openDB();
  } catch (e) {
    document.body.innerHTML =
      '<p style="padding:24px">Не вдалося відкрити локальну базу даних. ' +
      'Приватний режим браузера блокує IndexedDB — відкрий сторінку у звичайному вікні.</p>';
    return;
  }
  await loadSettings();
  wire();
  loadVoices();
  applySoundState();
  await renderStreakFromStore();
  await refreshDueBadge();
  nav('review');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
})();
