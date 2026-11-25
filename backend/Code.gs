/**
 * ============================================================
 * УЧЁТ ВЫДАННОГО АВАНСА — защищённый бэкенд (Google Apps Script)
 *
 * Что нового по сравнению со старой версией:
 *  1. API-ключ: любой запрос doGet/doPost обязан передать ?key=...
 *     (или поле "key" в JSON). Без ключа — отказ. Это отсекает ботов
 *     и всех, кто просто нашёл ссылку.
 *  2. Проверка данных: лимиты длины, диапазон суммы, формат даты —
 *     мусор в таблицу записать нельзя.
 *  3. Лимит запросов в час — защита от заливки и подбора.
 *  4. Лист «Журнал»: фиксируется каждое добавление/удаление —
 *     удалённое всегда можно восстановить руками.
 *  5. Резервные копии: ежедневные копии листа «Выдачи» в листы
 *     «Резерв …» (хранятся последние 14).
 *  6. Защита листов от редактирования чужими руками.
 *
 * УСТАНОВКА (5 минут):
 *  1. Расширения → Apps Script → выделить весь старый код → удалить →
 *     вставить этот файл → Сохранить.
 *  2. В CONFIG ниже проверьте API_KEY — он должен совпадать со
 *     значением API_KEY в app.js приложения (github.com/maaloznal/murad-app).
 *  3. Выполните один раз функцию installDailyBackup (выпадающий список
 *     функций → «installDailyBackup» → «Выполнить») — создаст триггер
 *     ежедневного бэкапа в 3 часа ночи и защитит листы.
 *  4. Развернуть → Управление развертываниями → карандаш →
 *     «Версия: Новая версия» → Разверить. Ссылка НЕ изменится.
 *  5. Проверка: откройте ссылку exec в браузере без параметров —
 *     должно прийти {"status":"error","code":"AUTH",...}.
 *  6. В самой таблице: Файл → «Настроить доступ» → «Ограниченный»
 *     (убрать «Все, у кого есть ссылка»). Если таблица публиковалась
 *     в интернет (Файл → «Опубликовать в интернете») — остановить
 *     публикацию. Скрипт работает от вашего имени и продолжит писать.
 * ============================================================
 */

var CONFIG = {
  // Секретный ключ доступа. Совпадает с API_KEY в app.js.
  API_KEY: 'avans_c954aac69ab341287cb6c23d2a46bf33',

  SHEET_LOG: 'Выдачи',
  SHEET_SUM: 'Сводка',
  SHEET_AUDIT: 'Журнал',

  MAX_NAME_LEN: 60,        // имя / фамилия
  MAX_PLATE_LEN: 20,       // гос. номер
  MAX_ID_LEN: 40,
  MAX_AMOUNT: 10000000,    // не более 10 млн за одну выдачу
  READS_PER_HOUR: 600,     // лимит чтений (на всех пользователей)
  WRITES_PER_HOUR: 120,    // лимит записей
  AUDIT_KEEP_ROWS: 3000,   // сколько строк журнала хранить
  BACKUP_KEEP: 14,         // сколько ежедневных резервов хранить
  BACKUP_HOUR: 3           // час запуска бэкапа (ночью)
};

/* ==================== Точки входа ==================== */

function doGet(e) {
  try {
    if (!authorized(e, null)) return fail('AUTH', 'Неверный ключ доступа');
    rateLimit('read');
    return json({ status: 'ok', records: readRecords() });
  } catch (err) {
    return fail('ERR', safeMsg(err));
  }
}

function doPost(e) {
  var body = getBody(e);
  try {
    if (!authorized(e, body)) return fail('AUTH', 'Неверный ключ доступа');
    rateLimit('write');

    var action = String(body.action || '');
    if (action === 'add') return doAdd(body);
    if (action === 'delete') return doDelete(body);
    return fail('ARGS', 'Неизвестное действие');
  } catch (err) {
    return fail('ERR', safeMsg(err));
  }
}

/* ==================== Ключ доступа ==================== */

function authorized(e, body) {
  var k = String((e && e.parameter && e.parameter.key) || (body && body.key) || '');
  return k.length > 0 && k === CONFIG.API_KEY;
}

function getBody(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents) || {};
    }
  } catch (ignore) { /* тело не JSON — ключ всё равно не найдётся */ }
  return {};
}

/* ==================== Лимит запросов ==================== */

function rateLimit(kind) {
  var props = PropertiesService.getScriptProperties();
  var hour = new Date().getHours();
  var bucket = 'rl_' + kind + '_' + hour;
  var count = Number(props.getProperty(bucket) || '0') + 1;
  props.setProperty(bucket, String(count));
  if (count === 1) cleanupRateBuckets(props, hour);

  var limit = (kind === 'read') ? CONFIG.READS_PER_HOUR : CONFIG.WRITES_PER_HOUR;
  if (count > limit) throw new Error('RATE_LIMIT');
}

function cleanupRateBuckets(props, currentHour) {
  var all = props.getProperties();
  for (var k in all) {
    var m = /^rl_(read|write)_(\d+)$/.exec(k);
    if (m && Number(m[2]) !== currentHour) props.deleteProperty(k);
  }
}

/* ==================== Проверка данных ==================== */

function cleanText(v, maxLen) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function toAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(String(v).replace(',', '.'));
  if (!isFinite(n)) return null;
  n = Math.round(n);
  if (n <= 0 || n > CONFIG.MAX_AMOUNT) return null;
  return n;
}

function toIsoDate(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime()) && d.getMonth() === Number(m[2]) - 1) return s;
  }
  var p = new Date(s);
  if (!isNaN(p.getTime())) return Utilities.formatDate(p, tz(), 'yyyy-MM-dd');
  return null;
}

function tz() { return Session.getScriptTimeZone(); }

function genId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ==================== Листы ==================== */

function sheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function logSheet() {
  return sheet(CONFIG.SHEET_LOG, ['ID', 'Дата выдачи', 'Имя', 'Фамилия', 'Гос. номер', 'Сумма']);
}

function headerOffset(sh) {
  var v = String(sh.getRange(1, 1).getValue()).trim();
  return v.toUpperCase() === 'ID' ? 2 : 1;
}

/* ==================== Чтение ==================== */

function readRecords() {
  var sh = logSheet();
  var last = sh.getLastRow();
  if (last < 1) return [];
  var first = headerOffset(sh);
  if (last < first) return [];

  var values = sh.getRange(first, 1, last - first + 1, 6).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var id = String(r[0] == null ? '' : r[0]).trim();
    if (!id || id.toUpperCase() === 'ID') continue; // пустые строки и заголовок
    out.push({
      id: id,
      date: toIsoDate(r[1]) || '',
      firstName: String(r[2] == null ? '' : r[2]).trim(),
      lastName: String(r[3] == null ? '' : r[3]).trim(),
      plate: String(r[4] == null ? '' : r[4]).trim().toUpperCase(),
      amount: Math.round(Number(r[5]) || 0)
    });
  }
  return out;
}

/* ==================== Добавление ==================== */

function doAdd(body) {
  var firstName = cleanText(body.firstName, CONFIG.MAX_NAME_LEN);
  var lastName = cleanText(body.lastName, CONFIG.MAX_NAME_LEN);
  var plate = cleanText(body.plate, CONFIG.MAX_PLATE_LEN).toUpperCase();
  var amount = toAmount(body.amount);
  var date = toIsoDate(body.date) || Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
  var id = cleanText(body.id, CONFIG.MAX_ID_LEN) || genId();

  if (!firstName || !lastName) return fail('ARGS', 'Заполните имя и фамилию');
  if (amount === null) return fail('ARGS', 'Неверная сумма (от 1 до ' + CONFIG.MAX_AMOUNT + ')');
  if (!/^[A-Za-z0-9\-_]+$/.test(id)) return fail('ARGS', 'Неверный ID записи');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    logSheet().appendRow([id, date, firstName, lastName, plate, amount]);
    rebuildSummary();
    audit('Выдано: ' + lastName + ' ' + firstName +
      (plate ? ', № ' + plate : '') + ' — ' + amount + ' ₽ (' + date + ')', id);
  } finally {
    lock.releaseLock();
  }
  return json({ status: 'ok', id: id });
}

/* ==================== Удаление ==================== */

function doDelete(body) {
  var id = cleanText(body.id, CONFIG.MAX_ID_LEN);
  if (!id) return fail('ARGS', 'Не указан ID записи');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var found = false;
  try {
    var sh = logSheet();
    var last = sh.getLastRow();
    var first = headerOffset(sh);
    if (last >= first) {
      var values = sh.getRange(first, 1, last - first + 1, 6).getValues();
      for (var i = values.length - 1; i >= 0; i--) {
        if (String(values[i][0]).trim() === id) {
          var row = values[i];
          var ds = toIsoDate(row[1]) || String(row[1] || '');
          audit('Удалено: ' + row[3] + ' ' + row[2] +
            (row[4] ? ', № ' + row[4] : '') + ' — ' + (Math.round(Number(row[5]) || 0)) +
            ' ₽ (' + ds + '). Строку можно восстановить из листа «Резерв»', id);
          sh.deleteRow(first + i);
          found = true;
        }
      }
    }
    if (found) rebuildSummary();
  } finally {
    lock.releaseLock();
  }
  if (!found) return fail('NOT_FOUND', 'Запись не найдена — возможно, уже удалена');
  return json({ status: 'ok' });
}

/* ==================== Сводка ==================== */

function rebuildSummary() {
  var records = readRecords();
  var map = {};
  var order = [];
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var key = (r.firstName + '|' + r.lastName).toLowerCase();
    var e = map[key];
    if (!e) {
      e = { firstName: r.firstName, lastName: r.lastName, plates: {}, count: 0, total: 0 };
      map[key] = e;
      order.push(e);
    }
    if (r.plate) e.plates[r.plate] = true;
    e.count++;
    e.total += r.amount;
  }
  order.sort(function (a, b) { return b.total - a.total; });

  var sh = sheet(CONFIG.SHEET_SUM, null);
  var header = ['Имя', 'Фамилия', 'Гос. номер', 'Выдач', 'Всего выдано'];
  var rows = [];
  for (var j = 0; j < order.length; j++) {
    var p = order[j];
    var plates = [];
    for (var pk in p.plates) plates.push(pk);
    rows.push([p.firstName, p.lastName, plates.join(', '), p.count, p.total]);
  }
  sh.clearContents();
  sh.getRange(1, 1, 1, 5).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 5).setValues(rows);
    sh.getRange(2, 5, rows.length, 1).setNumberFormat('#,##0');
  }
}

/* ==================== Журнал действий ==================== */

function audit(text, refId) {
  try {
    var sh = sheet(CONFIG.SHEET_AUDIT, ['Время', 'Действие', 'ID записи']);
    var when = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
    sh.appendRow([when, text, refId || '']);
    var extra = sh.getLastRow() - 1 - CONFIG.AUDIT_KEEP_ROWS;
    if (extra > 500) sh.deleteRows(2, extra); // подрезаем изредка, не на каждой записи
  } catch (ignore) { /* журнал не должен ломать основное действие */ }
}

/* ==================== Резервные копии ==================== */

function backupNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(CONFIG.SHEET_LOG);
  if (!src) return false;
  var last = src.getLastRow();
  if (last < 1) return false;

  var values = src.getRange(1, 1, last, 6).getValues();
  var stamp = 'Резерв ' + Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH');
  var old = ss.getSheetByName(stamp);
  if (old) ss.deleteSheet(old);

  var b = ss.insertSheet(stamp);
  b.getRange(1, 1, values.length, 6).setValues(values);
  b.getRange(1, 1, 1, 6).setFontWeight('bold');
  trimBackups(ss);
  return true;
}

function trimBackups(ss) {
  var names = [];
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName();
    if (n.indexOf('Резерв ') === 0) names.push(n);
  }
  names.sort(); // формат имени sortable: старые сверху
  while (names.length > CONFIG.BACKUP_KEEP) {
    var drop = ss.getSheetByName(names.shift());
    if (drop) ss.deleteSheet(drop);
  }
}

/** Запустить ОДИН раз вручную: ежедневный бэкап в 3:00 + защита листов. */
function installDailyBackup() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'backupNow') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('backupNow')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.BACKUP_HOUR)
    .create();
  backupNow();          // сразу делаем первую копию
  protectSheets();      // и защищаем листы
}

/** Листы нельзя редактировать никому, кроме владельца таблицы. */
function protectSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var names = [CONFIG.SHEET_LOG, CONFIG.SHEET_SUM, CONFIG.SHEET_AUDIT];
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName();
    if (n.indexOf('Резерв ') === 0) names.push(n);
  }
  for (var j = 0; j < names.length; j++) {
    var sh = ss.getSheetByName(names[j]);
    if (!sh) continue;
    try {
      var p = sh.protect().setDescription('Данные приложения — не редактировать руками');
      var editors = p.getEditors();
      for (var k = 0; k < editors.length; k++) p.removeEditor(editors[k]);
      if (p.canDomainEdit()) p.setDomainEdit(false);
    } catch (ignore) { /* защита необязательна */ }
  }
}

/* ==================== Ответы ==================== */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(code, msg) {
  return json({ status: 'error', code: code, message: msg });
}

function safeMsg(err) {
  if (String(err && err.message) === 'RATE_LIMIT') {
    return 'Слишком много запросов в час — попробуйте позже';
  }
  return 'Ошибка сервера';
}
