// src/App.tsx
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Briefcase,
  BookOpen,
  Eye,
  Plus,
  Search,
  Download,
  Trash2,
  Edit3,
  Tag,
  Clock,
  CheckCircle2,
  HelpCircle,
  Sparkles,
  FileSpreadsheet,
  SlidersHorizontal,
  X,
  Moon,
  Sun,
  Upload,
  Database,
  Layers,
  AlertCircle,
  Lightbulb,
  Target,
  Activity,
  Award,
  RotateCcw,
  Check,
  Table,
  FilePlus2,
  CalendarRange,
  MessageSquarePlus,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff
} from 'lucide-react';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  getDoc,
  writeBatch
} from 'firebase/firestore';
import { db } from './firebase';

// ============================================================================
// 1. データモデル定義 (TypeScript)
// ============================================================================
export type LogType = 'work' | 'study' | 'self';

export interface GrowthLog {
  id: string; // UUID
  date: string; // YYYY-MM-DD
  type: LogType;
  title: string;
  freeText: string;
  tags: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO

  // 業務ログ固有項目 (任意)
  workDetails?: string;    // 取り組んだこと
  workBottleneck?: string; // 詰まったこと・判断に迷ったこと
  workLearnings?: string;  // 得られた知見
  workNextAction?: string; // 次に生かすこと

  // 学習ログ固有項目 (任意)
  studyCategory?: string;           // 学習分野
  studyMinutes?: number;            // 学習時間 (分)
  studyContent?: string;            // 学習内容
  studyMethod?: string;             // 学習方法
  studySolvedProblems?: string;     // 解けた問題
  studyUnderstoodConcepts?: string; // 理解できた概念
  studyArtifacts?: string;          // 自力で実装できたもの・成果物
  studyQuestions?: string;          // 未解決の疑問
  studyQuestionResolved?: boolean;  // 疑問の解決フラグ
  studyQuestionResolutionNote?: string; // 疑問の解決メモ

  // 自己観察ログ固有項目 (任意)
  selfObservedFact?: string;        // 観察した事実
  selfThought?: string;             // そのときの考え
  selfHypothesis?: string;          // 自分についての仮説
  selfNextAction?: string;          // 次に試すこと
  selfHypothesisVerified?: boolean; // 仮説の検証完了フラグ
  selfHypothesisVerificationNote?: string; // 仮説の検証結果メモ
}

type EditableFieldKey =
  | 'title'
  | 'tags'
  | 'freeText'
  | 'workDetails'
  | 'workBottleneck'
  | 'workLearnings'
  | 'workNextAction'
  | 'studyCategory'
  | 'studyMinutes'
  | 'studyMethod'
  | 'studyContent'
  | 'studyUnderstoodConcepts'
  | 'studySolvedProblems'
  | 'studyArtifacts'
  | 'studyQuestions'
  | 'studyQuestionResolved'
  | 'studyQuestionResolutionNote'
  | 'selfObservedFact'
  | 'selfThought'
  | 'selfHypothesis'
  | 'selfNextAction'
  | 'selfHypothesisVerified'
  | 'selfHypothesisVerificationNote';

interface MatrixRowSpec {
  key: EditableFieldKey;
  label: string;
  group?: 'common' | 'work' | 'activity' | 'outcome' | 'question' | 'self';
  inputType: 'text' | 'textarea' | 'number' | 'tags' | 'boolean';
  placeholder?: string;
}

// ============================================================================
// 2. Firestore + IndexedDB ハイブリッド永続化レイヤー
// ============================================================================
const DB_NAME = 'PersonalGrowthLogDB';
const DB_VERSION = 1;
const STORE_NAME = 'growth_logs';
const TAG_REGISTRY_STORAGE_KEY = 'pgl_tag_registry_v1';
const FIRESTORE_LOGS_COLLECTION = 'growth_logs';
const FIRESTORE_META_COLLECTION = 'app_meta';
const FIRESTORE_TAG_DOC = 'tag_registry';

// Firebase config がプレースホルダーから変更されているか判定
const isFirebaseConfigured = (): boolean => {
  try {
    const projectId = db.app.options.projectId;
    const apiKey = db.app.options.apiKey;
    return Boolean(
      projectId &&
      apiKey &&
      projectId !== 'YOUR_PROJECT_ID' &&
      apiKey !== 'YOUR_API_KEY'
    );
  } catch {
    return false;
  }
};

function openLocalDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const idb = request.result;
      if (!idb.objectStoreNames.contains(STORE_NAME)) {
        const store = idb.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllLogs(): Promise<GrowthLog[]> {
  // 1. Firestore から取得（2.5秒でタイムアウトしてローカルIndexedDBにフォールバック）
  if (isFirebaseConfigured()) {
    try {
      const fetchPromise = getDocs(collection(db, FIRESTORE_LOGS_COLLECTION));
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Firestore timeout')), 2500)
      );

      const snapshot = await Promise.race([fetchPromise, timeoutPromise]);
      const remoteLogs: GrowthLog[] = [];
      snapshot.forEach((docSnap) => {
        remoteLogs.push(docSnap.data() as GrowthLog);
      });

      if (remoteLogs.length > 0) {
        const idb = await openLocalDB();
        const tx = idb.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        remoteLogs.forEach((item) => store.put(item));
        return remoteLogs;
      }
    } catch (err) {
      console.warn('Firestore fetch failed or timed out, falling back to local IndexedDB:', err);
    }
  }

  // 2. ローカル IndexedDB から取得
  const idb = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as GrowthLog[]) || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbSaveLog(log: GrowthLog): Promise<void> {
  // ローカル IndexedDB 保存
  const idb = await openLocalDB();
  await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(log);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Firestore 同期
  if (isFirebaseConfigured()) {
    try {
      const cleanData = JSON.parse(JSON.stringify(log));
      await setDoc(doc(db, FIRESTORE_LOGS_COLLECTION, log.id), cleanData);
    } catch (err) {
      console.warn('Firestore save failed (saved locally):', err);
    }
  }
}

async function dbDeleteLog(id: string): Promise<void> {
  // ローカル IndexedDB 削除
  const idb = await openLocalDB();
  await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Firestore 削除
  if (isFirebaseConfigured()) {
    try {
      await deleteDoc(doc(db, FIRESTORE_LOGS_COLLECTION, id));
    } catch (err) {
      console.warn('Firestore delete failed (deleted locally):', err);
    }
  }
}

async function dbClearAndSeed(logs: GrowthLog[]): Promise<void> {
  const idb = await openLocalDB();
  await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const item of logs) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  if (isFirebaseConfigured()) {
    try {
      const existing = await getDocs(collection(db, FIRESTORE_LOGS_COLLECTION));
      const batch = writeBatch(db);
      existing.forEach((docSnap) => batch.delete(docSnap.ref));
      logs.forEach((item) => {
        const cleanData = JSON.parse(JSON.stringify(item));
        batch.set(doc(db, FIRESTORE_LOGS_COLLECTION, item.id), cleanData);
      });
      await batch.commit();
    } catch (err) {
      console.warn('Firestore batch seed failed:', err);
    }
  }
}

async function fetchTagRegistry(): Promise<string[] | null> {
  if (isFirebaseConfigured()) {
    try {
      const fetchPromise = getDoc(doc(db, FIRESTORE_META_COLLECTION, FIRESTORE_TAG_DOC));
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 2500)
      );
      const snap = await Promise.race([fetchPromise, timeoutPromise]);
      if (snap.exists()) {
        const data = snap.data();
        if (Array.isArray(data.tags)) {
          localStorage.setItem(TAG_REGISTRY_STORAGE_KEY, JSON.stringify(data.tags));
          return data.tags as string[];
        }
      }
    } catch (err) {
      console.warn('Firestore tag registry fetch failed:', err);
    }
  }
  try {
    const saved = localStorage.getItem(TAG_REGISTRY_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

async function saveTagRegistry(tags: string[]): Promise<void> {
  try {
    localStorage.setItem(TAG_REGISTRY_STORAGE_KEY, JSON.stringify(tags));
  } catch {
    // ignore
  }
  if (isFirebaseConfigured()) {
    try {
      await setDoc(doc(db, FIRESTORE_META_COLLECTION, FIRESTORE_TAG_DOC), {
        tags,
        updatedAt: new Date().toISOString()
      });
    } catch (err) {
      console.warn('Firestore tag registry save failed:', err);
    }
  }
}

// ============================================================================
// 3. 純粋ローカル Multi-Sheet XLSX バイナリ生成エンジン (3シート構成)
// ============================================================================
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBlob(files: { name: string; content: string }[]): Blob {
  const encoder = new TextEncoder();
  const encodedFiles = files.map((f) => ({
    nameBytes: encoder.encode(f.name),
    dataBytes: encoder.encode(f.content),
  }));

  let offset = 0;
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];

  for (const file of encodedFiles) {
    const crc = crc32(file.dataBytes);
    const size = file.dataBytes.length;
    const nameLen = file.nameBytes.length;

    const localHeader = new Uint8Array(30 + nameLen);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x2100, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameLen, true);
    lv.setUint16(28, 0, true);
    localHeader.set(file.nameBytes, 30);

    localParts.push(localHeader, file.dataBytes);

    const centralHeader = new Uint8Array(46 + nameLen);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x2100, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameLen, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(file.nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + size;
  }

  const centralSize = centralParts.reduce((acc, p) => acc + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, encodedFiles.length, true);
  ev.setUint16(10, encodedFiles.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colIndexToLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

interface SheetSpec {
  name: string;
  headerStyleId: number;
  columns: { header: string; width: number }[];
  rows: (string | number | undefined)[][];
}

function buildWorksheetXml(sheet: SheetSpec): string {
  const colsXml = sheet.columns
    .map((c, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${c.width}" customWidth="1"/>`)
    .join('');

  const headerCells = sheet.columns
    .map((c, cIdx) => {
      const ref = `${colIndexToLetter(cIdx)}1`;
      return `<c r="${ref}" t="inlineStr" s="${sheet.headerStyleId}"><is><t>${escapeXml(c.header)}</t></is></c>`;
    })
    .join('');

  const dataRowsXml = sheet.rows
    .map((row, rIdx) => {
      const rowNum = rIdx + 2;
      const cells = row
        .map((val, cIdx) => {
          const ref = `${colIndexToLetter(cIdx)}${rowNum}`;
          if (typeof val === 'number' && !Number.isNaN(val)) {
            return `<c r="${ref}" s="4"><v>${val}</v></c>`;
          }
          const textVal = val === undefined || val === null ? '' : String(val);
          return `<c r="${ref}" t="inlineStr" s="5"><is><t>${escapeXml(textVal)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${colsXml}</cols>
  <sheetData>
    <row r="1" ht="26" customHeight="1">${headerCells}</row>
    ${dataRowsXml}
  </sheetData>
</worksheet>`;
}

function generateGrowthLogExcel(logs: GrowthLog[]): Blob {
  const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const workLogs = sorted.filter((l) => l.type === 'work');
  const studyLogs = sorted.filter((l) => l.type === 'study');
  const selfLogs = sorted.filter((l) => l.type === 'self');

  const sheets: SheetSpec[] = [
    {
      name: '業務ログ',
      headerStyleId: 1,
      columns: [
        { header: '日付', width: 14 },
        { header: 'タイトル', width: 28 },
        { header: '取り組んだこと (事実・行動)', width: 36 },
        { header: '詰まったこと・判断に迷ったこと', width: 36 },
        { header: '得られた知見・学び', width: 36 },
        { header: '次に生かすこと (Next Action)', width: 34 },
        { header: '自由記述・補足メモ', width: 36 },
        { header: 'タグ', width: 22 },
        { header: '記録ID', width: 20 },
        { header: '更新日時', width: 22 },
      ],
      rows: workLogs.map((l) => [
        l.date,
        l.title,
        l.workDetails || '',
        l.workBottleneck || '',
        l.workLearnings || '',
        l.workNextAction || '',
        l.freeText || '',
        l.tags.join(', '),
        l.id,
        l.updatedAt,
      ]),
    },
    {
      name: '学習ログ',
      headerStyleId: 2,
      columns: [
        { header: '日付', width: 14 },
        { header: 'タイトル', width: 28 },
        { header: '[活動指標] 学習分野', width: 18 },
        { header: '[活動指標] 学習時間(分)', width: 18 },
        { header: '[活動指標] 学習方法', width: 18 },
        { header: '[活動指標] 学習内容', width: 34 },
        { header: '[成果の手掛かり] 理解できた概念・仕組み', width: 38 },
        { header: '[成果の手掛かり] 解けた問題・演習', width: 34 },
        { header: '[成果の手掛かり] 自力実装・成果物', width: 34 },
        { header: '[疑問課題] 未解決の疑問', width: 34 },
        { header: '[疑問課題] 解決ステータス', width: 18 },
        { header: '[疑問課題] 解決メモ', width: 34 },
        { header: '自由記述・補足メモ', width: 34 },
        { header: 'タグ', width: 22 },
        { header: '記録ID', width: 20 },
        { header: '更新日時', width: 22 },
      ],
      rows: studyLogs.map((l) => [
        l.date,
        l.title,
        l.studyCategory || '',
        l.studyMinutes ?? '',
        l.studyMethod || '',
        l.studyContent || '',
        l.studyUnderstoodConcepts || '',
        l.studySolvedProblems || '',
        l.studyArtifacts || '',
        l.studyQuestions || '',
        l.studyQuestions?.trim()
          ? l.studyQuestionResolved
            ? '解決済み'
            : '未解決'
          : '',
        l.studyQuestionResolutionNote || '',
        l.freeText || '',
        l.tags.join(', '),
        l.id,
        l.updatedAt,
      ]),
    },
    {
      name: '自己観察ログ',
      headerStyleId: 3,
      columns: [
        { header: '日付', width: 14 },
        { header: 'タイトル', width: 28 },
        { header: '[事実] 観察した事実 (客観的状況・行動)', width: 38 },
        { header: '[思考] そのときの考え・感情', width: 36 },
        { header: '[仮説] 自分についての仮説 (非断定的傾向)', width: 38 },
        { header: '[実験] 次に試すこと (検証アクション)', width: 36 },
        { header: '[仮説検証] 検証ステータス', width: 18 },
        { header: '[仮説検証] 検証結果メモ', width: 34 },
        { header: '自由記述・補足メモ', width: 34 },
        { header: 'タグ', width: 22 },
        { header: '記録ID', width: 20 },
        { header: '更新日時', width: 22 },
      ],
      rows: selfLogs.map((l) => [
        l.date,
        l.title,
        l.selfObservedFact || '',
        l.selfThought || '',
        l.selfHypothesis || '',
        l.selfNextAction || '',
        l.selfHypothesis?.trim()
          ? l.selfHypothesisVerified
            ? '検証完了'
            : '検証中'
          : '',
        l.selfHypothesisVerificationNote || '',
        l.freeText || '',
        l.tags.join(', '),
        l.id,
        l.updatedAt,
      ]),
    },
  ];

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="業務ログ" sheetId="1" r:id="rId1"/>
    <sheet name="学習ログ" sheetId="2" r:id="rId2"/>
    <sheet name="自己観察ログ" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="10"/><name val="Yu Gothic"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Yu Gothic"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF065F46"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF92400E"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD1D5DB"/></left>
      <right style="thin"><color rgb="FFD1D5DB"/></right>
      <top style="thin"><color rgb="FFD1D5DB"/></top>
      <bottom style="thin"><color rgb="FFD1D5DB"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
</styleSheet>`;

  return createZipBlob([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: buildWorksheetXml(sheets[0]) },
    { name: 'xl/worksheets/sheet2.xml', content: buildWorksheetXml(sheets[1]) },
    { name: 'xl/worksheets/sheet3.xml', content: buildWorksheetXml(sheets[2]) },
  ]);
}

// ============================================================================
// 4. 初期サンプルデータ & デフォルトタグ台帳
// ============================================================================
const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const daysAgoStr = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const formatDateWithWeekday = (dateStr: string) => {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(d.getTime())) return dateStr;
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${dateStr} (${weekdays[d.getDay()]})`;
};

const INITIAL_TAG_REGISTRY: string[] = [
  'SQL',
  'データマート',
  'OJT',
  'データベーススペシャリスト',
  'トランザクション',
  '正規化',
  '学習効率',
  'メタ認知',
  'タイムボックス',
  'LightGBM',
  '特徴量エンジニアリング',
  'バンキングアプリ',
  'KPI設計',
  'Window関数',
  '因果推論'
];

const INITIAL_SAMPLE_LOGS: GrowthLog[] = [
  {
    id: 'sample-study-1',
    date: todayStr(),
    type: 'study',
    title: 'MVCCとトランザクション分離レベルの仕組み整理',
    freeText: 'なぜRepeatable Readでファントムリードが起きるのか、DBMS実装観点の因果関係が繋がった。',
    tags: ['データベーススペシャリスト', 'トランザクション', 'SQL'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    studyCategory: 'データベース・資格',
    studyMinutes: 75,
    studyMethod: '過去問演習 + 図解構造化',
    studyContent: 'トランザクション分離レベル（Read Committed / Repeatable Read / Serializable）とスナップショット分離の挙動比較',
    studyUnderstoodConcepts: 'ロックベース制御とMVCC（多版同時実行制御）において、読み取り一貫性を保証するためにどの時点のスナップショットを参照するかの違いを自分の言葉で説明できるようになった。',
    studySolvedProblems: '令和5年度 データベーススペシャリスト 午後I 問2（排他制御とデッドロック解析）',
    studyArtifacts: '分離レベル別の異常現象（Dirty Read / Non-Repeatable Read / Phantom Read）発生メカニズム整理ノート',
    studyQuestions: 'ギャップロック（Next-Key Lock）が複合インデックスの一部カラムのみ条件指定された場合にどこまでロック範囲を広げるか？',
    studyQuestionResolved: false,
    studyQuestionResolutionNote: '',
  },
  {
    id: 'sample-work-1',
    date: daysAgoStr(1),
    type: 'work',
    title: 'アプリログ集計SQLのWindow関数リファクタリングと検算自動化',
    freeText: '自己結合を排除したことで実行計画がシンプルになり、レビューの可読性も大幅に上がった。',
    tags: ['SQL', 'データマート', 'OJT'],
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    workDetails: 'デジタルリテール施策のファネル分析用クエリで、セッション単位の離脱ステップ特定処理を自己結合から LEAD / FIRST_VALUE の Window関数へ書き換えた。',
    workBottleneck: '同一タイムスタンプで複数イベントが発生した際の順序保証（決定論的なソートキーの選定）で迷い、イベント連番カラムの仕様確認に30分要した。',
    workLearnings: 'ORDER BY 句に時刻だけでなく一意なイベントシーケンスIDを複合指定しないと集計の再現性が崩れる。先にデータ仕様書の主キー定義を確認すべきだった。',
    workNextAction: 'クエリ作成用のチェックリストに「Window関数のORDER BYにおける同値タイブレークキーの有無」を追加する。',
  },
  {
    id: 'sample-self-1',
    date: daysAgoStr(2),
    type: 'self',
    title: '新出概念の学習時に周辺理論まで一気に深掘りして時間を溶かす傾向の観察',
    freeText: '「なぜそうなるのか」の因果が繋がると納得できる一方、目的範囲の境界線を先に引く仕組みが必要。',
    tags: ['学習効率', 'メタ認知', 'タイムボックス'],
    createdAt: new Date(Date.now() - 172800000).toISOString(),
    updatedAt: new Date(Date.now() - 172800000).toISOString(),
    selfObservedFact: '問題演習を30分で終える予定だったが、解説に出てきたB+Treeのページ分割アルゴリズムの内部実装が気になり、関連論文や記事を90分調べ続けていた。',
    selfThought: '「ブラックボックスのまま暗記したくない、根本原理から完全に理解してから次の問題に進みたい」と考えていた。',
    selfHypothesis: '原理原則や因果関係の把握を重視する強みがある反面、「今解くべき問題のスコープ」と「後で深掘りする好奇心ストック」が未分離だと学習ROIが低下しやすいのではないか。',
    selfNextAction: '演習中に生じた深い疑問は一度このログの「未解決の疑問」に書き出してタイムボックス（15分）を設け、まずは1周解き切る運用を試す。',
    selfHypothesisVerified: false,
    selfHypothesisVerificationNote: '',
  },
  {
    id: 'sample-study-2',
    date: daysAgoStr(3),
    type: 'study',
    title: '勾配ブースティング木の分岐評価式とTarget Encodingのリーク防止設計',
    freeText: '数式の途中変形を1ステップずつ書き下したことで、正則化項が木の複雑度をどう抑えるか腹落ちした。',
    tags: ['LightGBM', '特徴量エンジニアリング'],
    createdAt: new Date(Date.now() - 259200000).toISOString(),
    updatedAt: new Date(Date.now() - 259200000).toISOString(),
    studyCategory: '機械学習・統計',
    studyMinutes: 60,
    studyMethod: '数式導出 + Python検証実装',
    studyContent: 'GBDTにおける2次テイラー展開を用いた目的関数の近似と、Out-of-Fold Target Encodingの実装パターン',
    studyUnderstoodConcepts: '葉の重み w* と Gain の導出において、L2正則化パラメータ λ が分母に入ることでサンプル数が少ない葉の極端な予測値を抑制する仕組み。',
    studySolvedProblems: '時系列データに対してKFoldでTarget Encodingを行うと未来情報のリークが起きるケースの修正問題',
    studyArtifacts: 'TimeSeriesSplit対応のリークフリー特徴量変換パイプライン関数',
    studyQuestions: '',
    studyQuestionResolved: false,
    studyQuestionResolutionNote: '',
  },
  {
    id: 'sample-work-2',
    date: daysAgoStr(4),
    type: 'work',
    title: 'OMOキャンペーン効果測定の施策前後比較における交絡因子の洗い出し',
    freeText: '単純な前後比較ではなく、季節性とアプリ通知配信有無を切り分ける集計軸を提案できた。',
    tags: ['バンキングアプリ', 'KPI設計'],
    createdAt: new Date(Date.now() - 345600000).toISOString(),
    updatedAt: new Date(Date.now() - 345600000).toISOString(),
    workDetails: '店舗連携キャンペーン対象ユーザーのアプリログイン率・口座稼働率の集計定義書作成とSQLプロトタイプ実装。',
    workBottleneck: 'キャンペーン期間が給与振込日と重なっており、施策効果か定常的な月末月初効果かの切り分け基準で議論になった。',
    workLearnings: '分析設計の初期段階で「施策以外の主要変動要因（給与日・曜日・既存キャンペーン）」を簡単な因果図として書き出して合意形成すると手戻りが減る。',
    workNextAction: '次回以降の施策効果検証では、SQLを書く前に比較対照群の条件を1枚のメモにまとめてレビュー依頼する。',
  },
];

// ============================================================================
// 5. UI ヘルパー & メタ設定
// ============================================================================
const TYPE_META: Record<
  LogType,
  {
    label: string;
    shortLabel: string;
    badgeBg: string;
    badgeText: string;
    borderAccent: string;
    icon: React.ComponentType<{ className?: string }>;
    description: string;
  }
> = {
  study: {
    label: '学習ログ',
    shortLabel: '学習',
    badgeBg: 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800',
    badgeText: 'text-emerald-700 dark:text-emerald-300',
    borderAccent: 'border-l-emerald-500',
    icon: BookOpen,
    description: '「活動量（時間・内容）」と「成果の手掛かり（理解・解けた問題・実装物）」を分離して記録',
  },
  work: {
    label: '業務ログ',
    shortLabel: '業務',
    badgeBg: 'bg-blue-50 dark:bg-blue-950/60 border-blue-200 dark:border-blue-800',
    badgeText: 'text-blue-700 dark:text-blue-300',
    borderAccent: 'border-l-blue-600',
    icon: Briefcase,
    description: '取り組んだ事実・詰まったボトルネック・得られた知見・次へのアクションを記録',
  },
  self: {
    label: '自己観察ログ',
    shortLabel: '自己観察',
    badgeBg: 'bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-800',
    badgeText: 'text-amber-700 dark:text-amber-300',
    borderAccent: 'border-l-amber-500',
    icon: Eye,
    description: '「観察した事実」「当時の考え」「自分についての仮説」「次に試すこと」を分離して記録',
  },
};

function autoCompleteTitle(form: Partial<GrowthLog>, type: LogType): string {
  if (form.title && form.title.trim()) return form.title.trim();

  const candidates: (string | undefined)[] = [
    form.freeText,
    type === 'work' ? form.workDetails || form.workLearnings || form.workBottleneck || form.workNextAction : undefined,
    type === 'study'
      ? form.studyUnderstoodConcepts ||
        form.studyContent ||
        form.studySolvedProblems ||
        form.studyArtifacts ||
        form.studyQuestions
      : undefined,
    type === 'self'
      ? form.selfObservedFact || form.selfHypothesis || form.selfThought || form.selfNextAction
      : undefined,
  ];

  for (const c of candidates) {
    if (c && c.trim()) {
      const firstLine = c.trim().split('\n')[0].trim();
      return firstLine.length > 38 ? `${firstLine.slice(0, 38)}…` : firstLine;
    }
  }
  return `${form.date || todayStr()} の${TYPE_META[type].label}`;
}

function hasAtLeastOneContent(form: Partial<GrowthLog>, type: LogType): boolean {
  if (form.freeText && form.freeText.trim().length > 0) return true;
  if (type === 'work') {
    return Boolean(
      form.workDetails?.trim() ||
        form.workBottleneck?.trim() ||
        form.workLearnings?.trim() ||
        form.workNextAction?.trim()
    );
  }
  if (type === 'study') {
    return Boolean(
      form.studyCategory?.trim() ||
        (form.studyMinutes !== undefined && form.studyMinutes > 0) ||
        form.studyContent?.trim() ||
        form.studyMethod?.trim() ||
        form.studySolvedProblems?.trim() ||
        form.studyUnderstoodConcepts?.trim() ||
        form.studyArtifacts?.trim() ||
        form.studyQuestions?.trim()
    );
  }
  if (type === 'self') {
    return Boolean(
      form.selfObservedFact?.trim() ||
        form.selfThought?.trim() ||
        form.selfHypothesis?.trim() ||
        form.selfNextAction?.trim()
    );
  }
  return false;
}

function HighlightedText({ text, query }: { text?: string; query: string }) {
  if (!text) return <span className="text-slate-300 dark:text-slate-600">-</span>;
  const q = query.trim();
  if (!q) return <>{text}</>;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="bg-amber-200 dark:bg-amber-700/80 text-slate-900 dark:text-white rounded px-0.5 font-medium"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

// ============================================================================
// 6. 縦持ちテーブルの行定義（「タイトル」〜「自由記述・補足メモ」）
// ============================================================================
const WORK_MATRIX_ROWS: MatrixRowSpec[] = [
  { key: 'title', label: 'タイトル', group: 'common', inputType: 'text', placeholder: 'タイトルを入力...' },
  { key: 'workDetails', label: '取り組んだこと (事実・行動)', group: 'work', inputType: 'textarea', placeholder: '取り組んだことを入力...' },
  { key: 'workBottleneck', label: '詰まったこと・判断に迷ったこと', group: 'work', inputType: 'textarea', placeholder: '詰まったこと・迷ったことを入力...' },
  { key: 'workLearnings', label: '得られた知見・学び', group: 'work', inputType: 'textarea', placeholder: '得られた知見・学びを入力...' },
  { key: 'workNextAction', label: '次に生かすこと (Next Action)', group: 'work', inputType: 'textarea', placeholder: '次に生かすことを入力...' },
  { key: 'tags', label: 'タグ (カンマ区切り)', group: 'common', inputType: 'tags', placeholder: 'SQL, OJT' },
  { key: 'freeText', label: '自由記述・補足メモ', group: 'common', inputType: 'textarea', placeholder: '自由記述・補足メモを入力...' },
];

const STUDY_MATRIX_ROWS: MatrixRowSpec[] = [
  { key: 'title', label: 'タイトル', group: 'common', inputType: 'text', placeholder: 'タイトルを入力...' },
  { key: 'studyCategory', label: '[活動指標] 学習分野', group: 'activity', inputType: 'text', placeholder: '統計, SQL, DBスペシャリストなど' },
  { key: 'studyMinutes', label: '[活動指標] 学習時間 (分)', group: 'activity', inputType: 'number', placeholder: '60' },
  { key: 'studyMethod', label: '[活動指標] 学習方法', group: 'activity', inputType: 'text', placeholder: '過去問演習, 書籍, 実装など' },
  { key: 'studyContent', label: '[活動指標] 学習内容', group: 'activity', inputType: 'textarea', placeholder: '学習した範囲やテーマを入力...' },
  { key: 'studyUnderstoodConcepts', label: '[成果の手掛かり] 理解できた概念・仕組み', group: 'outcome', inputType: 'textarea', placeholder: '理解できた仕組み・因果関係を入力...' },
  { key: 'studySolvedProblems', label: '[成果の手掛かり] 解けた問題・演習', group: 'outcome', inputType: 'textarea', placeholder: '自力で解けた問題を入力...' },
  { key: 'studyArtifacts', label: '[成果の手掛かり] 自力実装・成果物', group: 'outcome', inputType: 'textarea', placeholder: '作成したコード・ノート等を入力...' },
  { key: 'studyQuestions', label: '[疑問課題] 未解決の疑問', group: 'question', inputType: 'textarea', placeholder: '未解決の疑問を入力...' },
  { key: 'studyQuestionResolved', label: '[疑問課題] 解決ステータス', group: 'question', inputType: 'boolean' },
  { key: 'studyQuestionResolutionNote', label: '[疑問課題] 解決メモ', group: 'question', inputType: 'textarea', placeholder: '疑問の解決メモを入力...' },
  { key: 'tags', label: 'タグ (カンマ区切り)', group: 'common', inputType: 'tags', placeholder: 'SQL, トランザクション' },
  { key: 'freeText', label: '自由記述・補足メモ', group: 'common', inputType: 'textarea', placeholder: '自由記述・補足メモを入力...' },
];

const SELF_MATRIX_ROWS: MatrixRowSpec[] = [
  { key: 'title', label: 'タイトル', group: 'common', inputType: 'text', placeholder: 'タイトルを入力...' },
  { key: 'selfObservedFact', label: '1. 観察した事実 (Fact)', group: 'self', inputType: 'textarea', placeholder: '客観的な事実・行動を入力...' },
  { key: 'selfThought', label: '2. そのときの考え・感情 (Thought)', group: 'self', inputType: 'textarea', placeholder: '当時の考え・感情を入力...' },
  { key: 'selfHypothesis', label: '3. 自分についての仮説 (Hypothesis)', group: 'self', inputType: 'textarea', placeholder: '非断定的な仮説を入力...' },
  { key: 'selfNextAction', label: '4. 次に試すこと (Next Experiment)', group: 'self', inputType: 'textarea', placeholder: '次に試すアクションを入力...' },
  { key: 'selfHypothesisVerified', label: '[仮説検証] 検証ステータス', group: 'self', inputType: 'boolean' },
  { key: 'selfHypothesisVerificationNote', label: '[仮説検証] 検証結果メモ', group: 'self', inputType: 'textarea', placeholder: '検証結果メモを入力...' },
  { key: 'tags', label: 'タグ (カンマ区切り)', group: 'common', inputType: 'tags', placeholder: '学習効率, メタ認知' },
  { key: 'freeText', label: '自由記述・補足メモ', group: 'common', inputType: 'textarea', placeholder: '自由記述・補足メモを入力...' },
];

const ALL_SUMMARY_MATRIX_ROWS: MatrixRowSpec[] = [
  { key: 'title', label: 'タイトル', group: 'common', inputType: 'text', placeholder: 'タイトルを入力...' },
  { key: 'workDetails', label: '[業務] 取り組んだこと', group: 'work', inputType: 'textarea', placeholder: '業務で取り組んだこと...' },
  { key: 'workLearnings', label: '[業務] 得られた知見・次へのアクション', group: 'work', inputType: 'textarea', placeholder: '得られた知見...' },
  { key: 'studyCategory', label: '[学習:活動] 学習分野', group: 'activity', inputType: 'text', placeholder: '学習分野...' },
  { key: 'studyMinutes', label: '[学習:活動] 学習時間 (分)', group: 'activity', inputType: 'number', placeholder: '60' },
  { key: 'studyContent', label: '[学習:活動] 学習内容', group: 'activity', inputType: 'textarea', placeholder: '学習内容...' },
  { key: 'studyUnderstoodConcepts', label: '[学習:成果] 理解できた概念', group: 'outcome', inputType: 'textarea', placeholder: '理解できた概念...' },
  { key: 'studySolvedProblems', label: '[学習:成果] 解けた問題・成果物', group: 'outcome', inputType: 'textarea', placeholder: '解けた問題...' },
  { key: 'studyQuestions', label: '[学習:疑問] 未解決の疑問', group: 'question', inputType: 'textarea', placeholder: '未解決の疑問...' },
  { key: 'selfObservedFact', label: '[自己観察] 観察した事実', group: 'self', inputType: 'textarea', placeholder: '観察した事実...' },
  { key: 'selfHypothesis', label: '[自己観察] 自分についての仮説', group: 'self', inputType: 'textarea', placeholder: '自分についての仮説...' },
  { key: 'selfNextAction', label: '[自己観察] 次に試すこと', group: 'self', inputType: 'textarea', placeholder: '次に試すこと...' },
  { key: 'tags', label: 'タグ (カンマ区切り)', group: 'common', inputType: 'tags', placeholder: 'タグ1, タグ2' },
  { key: 'freeText', label: '自由記述・補足メモ', group: 'common', inputType: 'textarea', placeholder: '自由記述・補足メモを入力...' },
];

// ============================================================================
// 7. メインアプリケーションコンポーネント
// ============================================================================
export default function App() {
  const [logs, setLogs] = useState<GrowthLog[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [darkMode, setDarkMode] = useState<boolean>(false);

  // タグ台帳（0件になったタグも一覧に残し、0件のときのみ「×」で削除可能にする）
  const [registeredTags, setRegisteredTags] = useState<string[]>(INITIAL_TAG_REGISTRY);

  // ページ構成: 'record' (新規登録専用) | 'spreadsheet' (一覧・Excelプレビュー + 検索) | 'insights' (振り返り・集計)
  const [activeTab, setActiveTab] = useState<'record' | 'spreadsheet' | 'insights'>('record');

  // 一覧・Excelプレビュー用の検索・フィルタ・表示状態
  // 順番: Sheet 1 (業務) → Sheet 2 (学習) → Sheet 3 (自己観察) → 全種別サマリー表
  const [previewSheet, setPreviewSheet] = useState<'work' | 'study' | 'self' | 'all'>('work');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string>('ALL');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  // 振り返り画面での「解決済み/検証完了も含めて表示」トグル
  const [showResolvedQuestions, setShowResolvedQuestions] = useState<boolean>(false);
  const [showVerifiedHypotheses, setShowVerifiedHypotheses] = useState<boolean>(false);

  // クイック解決メモ入力用のインライン状態
  const [resolvingNoteId, setResolvingNoteId] = useState<string | null>(null);
  const [resolvingNoteText, setResolvingNoteText] = useState<string>('');

  // ダブルクリックインライン編集用の状態
  const [editingCell, setEditingCell] = useState<{
    logId: string;
    fieldKey: EditableFieldKey;
  } | null>(null);
  const [editingCellValue, setEditingCellValue] = useState<string>('');

  // 上部横スクロールバーとテーブル本体のスクロール同期用Ref
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const [tableScrollWidth, setTableScrollWidth] = useState<number>(1200);
  const isSyncingScroll = useRef<boolean>(false);

  // 編集・入力フォーム状態
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<LogType>('study');
  const [formDate, setFormDate] = useState<string>(todayStr());
  const [formTitle, setFormTitle] = useState<string>('');
  const [formFreeText, setFormFreeText] = useState<string>('');
  const [formTagInput, setFormTagInput] = useState<string>('');
  const [formTags, setFormTags] = useState<string[]>([]);

  // 業務固有
  const [workDetails, setWorkDetails] = useState<string>('');
  const [workBottleneck, setWorkBottleneck] = useState<string>('');
  const [workLearnings, setWorkLearnings] = useState<string>('');
  const [workNextAction, setWorkNextAction] = useState<string>('');

  // 学習固有
  const [studyCategory, setStudyCategory] = useState<string>('');
  const [studyMinutes, setStudyMinutes] = useState<string>('');
  const [studyContent, setStudyContent] = useState<string>('');
  const [studyMethod, setStudyMethod] = useState<string>('');
  const [studySolvedProblems, setStudySolvedProblems] = useState<string>('');
  const [studyUnderstoodConcepts, setStudyUnderstoodConcepts] = useState<string>('');
  const [studyArtifacts, setStudyArtifacts] = useState<string>('');
  const [studyQuestions, setStudyQuestions] = useState<string>('');
  const [studyQuestionResolved, setStudyQuestionResolved] = useState<boolean>(false);
  const [studyQuestionResolutionNote, setStudyQuestionResolutionNote] = useState<string>('');

  // 自己観察固有
  const [selfObservedFact, setSelfObservedFact] = useState<string>('');
  const [selfThought, setSelfThought] = useState<string>('');
  const [selfHypothesis, setSelfHypothesis] = useState<string>('');
  const [selfNextAction, setSelfNextAction] = useState<string>('');
  const [selfHypothesisVerified, setSelfHypothesisVerified] = useState<boolean>(false);
  const [selfHypothesisVerificationNote, setSelfHypothesisVerificationNote] = useState<string>('');

  // 通知メッセージと直近保存ログ情報
  const [toast, setToast] = useState<{ text: string; kind?: 'success' | 'info' } | null>(null);
  const [lastSavedLog, setLastSavedLog] = useState<GrowthLog | null>(null);

  const showToast = useCallback((text: string, kind: 'success' | 'info' = 'success') => {
    setToast({ text, kind });
    setTimeout(() => {
      setToast((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  }, []);

  // 初回ロード（Firestore / IndexedDB）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const storedTagReg = await fetchTagRegistry();
        let existing = await dbGetAllLogs();
        if (existing.length === 0) {
          await dbClearAndSeed(INITIAL_SAMPLE_LOGS);
          existing = INITIAL_SAMPLE_LOGS;
        }
        if (mounted) {
          setLogs(existing);
          const logTags = new Set<string>(storedTagReg || INITIAL_TAG_REGISTRY);
          existing.forEach((l) => l.tags.forEach((t) => logTags.add(t)));
          const mergedTags = Array.from(logTags);
          setRegisteredTags(mergedTags);
          await saveTagRegistry(mergedTags);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Failed to load DB:', err);
        if (mounted) {
          setLogs(INITIAL_SAMPLE_LOGS);
          setIsLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // タグ台帳の永続化と、ログに含まれる新規タグの自動登録
  const registerNewTags = useCallback((newTags: string[]) => {
    setRegisteredTags((prev) => {
      const nextSet = new Set(prev);
      let changed = false;
      for (const t of newTags) {
        const trimmed = t.trim();
        if (trimmed && !nextSet.has(trimmed)) {
          nextSet.add(trimmed);
          changed = true;
        }
      }
      if (!changed) return prev;
      const arr = Array.from(nextSet);
      saveTagRegistry(arr);
      return arr;
    });
  }, []);

  // 0件のタグのみ削除するハンドラ
  const handleDeleteTagFromRegistry = useCallback(
    (tagToDelete: string, count: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (count > 0) {
        showToast(`「#${tagToDelete}」は ${count} 件の記録に付与されているため削除できません`, 'info');
        return;
      }
      setRegisteredTags((prev) => {
        const next = prev.filter((t) => t !== tagToDelete);
        saveTagRegistry(next);
        return next;
      });
      if (selectedTag === tagToDelete) {
        setSelectedTag('ALL');
      }
      showToast(`タグ「#${tagToDelete}」を削除しました`, 'info');
    },
    [selectedTag, showToast]
  );

  // フォームリセット
  const resetForm = useCallback((keepTypeAndDate = true) => {
    setEditingId(null);
    if (!keepTypeAndDate) {
      setFormDate(todayStr());
    }
    setFormTitle('');
    setFormFreeText('');
    setFormTagInput('');
    setFormTags([]);
    setWorkDetails('');
    setWorkBottleneck('');
    setWorkLearnings('');
    setWorkNextAction('');
    setStudyCategory('');
    setStudyMinutes('');
    setStudyContent('');
    setStudyMethod('');
    setStudySolvedProblems('');
    setStudyUnderstoodConcepts('');
    setStudyArtifacts('');
    setStudyQuestions('');
    setStudyQuestionResolved(false);
    setStudyQuestionResolutionNote('');
    setSelfObservedFact('');
    setSelfThought('');
    setSelfHypothesis('');
    setSelfNextAction('');
    setSelfHypothesisVerified(false);
    setSelfHypothesisVerificationNote('');
  }, []);

  // 現在の入力内容オブジェクト
  const currentDraft: Partial<GrowthLog> = useMemo(
    () => ({
      date: formDate,
      type: formType,
      title: formTitle,
      freeText: formFreeText,
      tags: formTags,
      workDetails,
      workBottleneck,
      workLearnings,
      workNextAction,
      studyCategory,
      studyMinutes: studyMinutes !== '' ? Number(studyMinutes) : undefined,
      studyContent,
      studyMethod,
      studySolvedProblems,
      studyUnderstoodConcepts,
      studyArtifacts,
      studyQuestions,
      studyQuestionResolved,
      studyQuestionResolutionNote,
      selfObservedFact,
      selfThought,
      selfHypothesis,
      selfNextAction,
      selfHypothesisVerified,
      selfHypothesisVerificationNote,
    }),
    [
      formDate,
      formType,
      formTitle,
      formFreeText,
      formTags,
      workDetails,
      workBottleneck,
      workLearnings,
      workNextAction,
      studyCategory,
      studyMinutes,
      studyContent,
      studyMethod,
      studySolvedProblems,
      studyUnderstoodConcepts,
      studyArtifacts,
      studyQuestions,
      studyQuestionResolved,
      studyQuestionResolutionNote,
      selfObservedFact,
      selfThought,
      selfHypothesis,
      selfNextAction,
      selfHypothesisVerified,
      selfHypothesisVerificationNote,
    ]
  );

  const isFormValid = useMemo(
    () => Boolean(formDate && formType && hasAtLeastOneContent(currentDraft, formType)),
    [formDate, formType, currentDraft]
  );

  // タグ追加・削除（フォーム内）
  const handleAddTag = (raw: string) => {
    const cleaned = raw
      .split(/[,\s、]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
    if (cleaned.length === 0) return;
    const next = Array.from(new Set([...formTags, ...cleaned]));
    setFormTags(next);
    registerNewTags(cleaned);
    setFormTagInput('');
  };

  const handleRemoveTagFromForm = (tag: string) => {
    setFormTags(formTags.filter((t) => t !== tag));
  };

  // 保存処理
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;

    const pendingTags = formTagInput
      .split(/[,\s、]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
    const mergedTags = Array.from(new Set([...formTags, ...pendingTags]));
    registerNewTags(mergedTags);

    const nowIso = new Date().toISOString();
    const existingLog = editingId ? logs.find((l) => l.id === editingId) : undefined;
    const finalTitle = autoCompleteTitle(currentDraft, formType);

    const record: GrowthLog = {
      id: editingId || (crypto.randomUUID ? crypto.randomUUID() : `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
      date: formDate,
      type: formType,
      title: finalTitle,
      freeText: formFreeText.trim(),
      tags: mergedTags,
      createdAt: existingLog ? existingLog.createdAt : nowIso,
      updatedAt: nowIso,

      ...(formType === 'work'
        ? {
            workDetails: workDetails.trim() || undefined,
            workBottleneck: workBottleneck.trim() || undefined,
            workLearnings: workLearnings.trim() || undefined,
            workNextAction: workNextAction.trim() || undefined,
          }
        : {}),

      ...(formType === 'study'
        ? {
            studyCategory: studyCategory.trim() || undefined,
            studyMinutes: studyMinutes !== '' && !Number.isNaN(Number(studyMinutes)) ? Number(studyMinutes) : undefined,
            studyContent: studyContent.trim() || undefined,
            studyMethod: studyMethod.trim() || undefined,
            studySolvedProblems: studySolvedProblems.trim() || undefined,
            studyUnderstoodConcepts: studyUnderstoodConcepts.trim() || undefined,
            studyArtifacts: studyArtifacts.trim() || undefined,
            studyQuestions: studyQuestions.trim() || undefined,
            studyQuestionResolved: studyQuestions.trim() ? studyQuestionResolved : false,
            studyQuestionResolutionNote: studyQuestionResolutionNote.trim() || undefined,
          }
        : {}),

      ...(formType === 'self'
        ? {
            selfObservedFact: selfObservedFact.trim() || undefined,
            selfThought: selfThought.trim() || undefined,
            selfHypothesis: selfHypothesis.trim() || undefined,
            selfNextAction: selfNextAction.trim() || undefined,
            selfHypothesisVerified: selfHypothesis.trim() ? selfHypothesisVerified : false,
            selfHypothesisVerificationNote: selfHypothesisVerificationNote.trim() || undefined,
          }
        : {}),
    };

    await dbSaveLog(record);
    setLogs((prev) => {
      const filtered = prev.filter((item) => item.id !== record.id);
      return [record, ...filtered];
    });

    setLastSavedLog(record);
    showToast(editingId ? '記録を更新しました' : '新しい記録を保存しました');
    resetForm(true);
  };

  // 「未解決の疑問」または「検証中の自己仮説」の完了ステータス切り替え処理
  const handleToggleQuestionResolved = async (log: GrowthLog, resolved: boolean, note?: string) => {
    const updated: GrowthLog = {
      ...log,
      studyQuestionResolved: resolved,
      studyQuestionResolutionNote:
        note !== undefined ? note.trim() || undefined : log.studyQuestionResolutionNote,
      updatedAt: new Date().toISOString(),
    };
    await dbSaveLog(updated);
    setLogs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setResolvingNoteId(null);
    setResolvingNoteText('');
    showToast(resolved ? '疑問を「解決済み」にしました（未解決リストから完了へ移動）' : '疑問を「未解決」に戻しました');
  };

  const handleToggleHypothesisVerified = async (log: GrowthLog, verified: boolean, note?: string) => {
    const updated: GrowthLog = {
      ...log,
      selfHypothesisVerified: verified,
      selfHypothesisVerificationNote:
        note !== undefined ? note.trim() || undefined : log.selfHypothesisVerificationNote,
      updatedAt: new Date().toISOString(),
    };
    await dbSaveLog(updated);
    setLogs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setResolvingNoteId(null);
    setResolvingNoteText('');
    showToast(verified ? '自己仮説を「検証完了」にしました（検証中リストから完了へ移動）' : '自己仮説を「検証中」に戻しました');
  };

  // 編集開始（振り返りページ等からフォームへ遷移する場合）
  const handleEdit = (log: GrowthLog) => {
    setEditingId(log.id);
    setFormType(log.type);
    setFormDate(log.date);
    setFormTitle(log.title);
    setFormFreeText(log.freeText || '');
    setFormTags(log.tags || []);
    setFormTagInput('');

    setWorkDetails(log.workDetails || '');
    setWorkBottleneck(log.workBottleneck || '');
    setWorkLearnings(log.workLearnings || '');
    setWorkNextAction(log.workNextAction || '');

    setStudyCategory(log.studyCategory || '');
    setStudyMinutes(log.studyMinutes !== undefined ? String(log.studyMinutes) : '');
    setStudyContent(log.studyContent || '');
    setStudyMethod(log.studyMethod || '');
    setStudySolvedProblems(log.studySolvedProblems || '');
    setStudyUnderstoodConcepts(log.studyUnderstoodConcepts || '');
    setStudyArtifacts(log.studyArtifacts || '');
    setStudyQuestions(log.studyQuestions || '');
    setStudyQuestionResolved(Boolean(log.studyQuestionResolved));
    setStudyQuestionResolutionNote(log.studyQuestionResolutionNote || '');

    setSelfObservedFact(log.selfObservedFact || '');
    setSelfThought(log.selfThought || '');
    setSelfHypothesis(log.selfHypothesis || '');
    setSelfNextAction(log.selfNextAction || '');
    setSelfHypothesisVerified(Boolean(log.selfHypothesisVerified));
    setSelfHypothesisVerificationNote(log.selfHypothesisVerificationNote || '');

    setActiveTab('record');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 削除処理
  const handleDelete = async (id: string) => {
    await dbDeleteLog(id);
    setLogs((prev) => prev.filter((l) => l.id !== id));
    if (editingId === id) resetForm(true);
    if (lastSavedLog?.id === id) setLastSavedLog(null);
    showToast('記録を削除しました', 'info');
  };

  // Excelプレビューセルのダブルクリック編集開始
  const startCellEditing = (log: GrowthLog, rowSpec: MatrixRowSpec) => {
    if (rowSpec.inputType === 'boolean') {
      if (rowSpec.key === 'studyQuestionResolved') {
        handleToggleQuestionResolved(log, !log.studyQuestionResolved);
      } else if (rowSpec.key === 'selfHypothesisVerified') {
        handleToggleHypothesisVerified(log, !log.selfHypothesisVerified);
      }
      return;
    }

    let initialVal = '';
    if (rowSpec.key === 'tags') {
      initialVal = (log.tags || []).join(', ');
    } else if (rowSpec.key === 'studyMinutes') {
      initialVal = log.studyMinutes !== undefined ? String(log.studyMinutes) : '';
    } else {
      const raw = log[rowSpec.key as keyof GrowthLog];
      initialVal = typeof raw === 'string' ? raw : '';
    }

    setEditingCell({ logId: log.id, fieldKey: rowSpec.key });
    setEditingCellValue(initialVal);
  };

  // Excelプレビューセルの編集確定保存
  const commitCellEditing = async (log: GrowthLog, rowSpec: MatrixRowSpec, overrideValue?: string) => {
    if (!editingCell || editingCell.logId !== log.id || editingCell.fieldKey !== rowSpec.key) return;
    const rawVal = overrideValue !== undefined ? overrideValue : editingCellValue;
    const trimmed = rawVal.trim();

    const updated: GrowthLog = {
      ...log,
      updatedAt: new Date().toISOString(),
    };

    if (rowSpec.key === 'tags') {
      const nextTags = trimmed
        .split(/[,\s、]+/)
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean);
      updated.tags = Array.from(new Set(nextTags));
      registerNewTags(updated.tags);
    } else if (rowSpec.key === 'studyMinutes') {
      const num = Number(trimmed);
      updated.studyMinutes = trimmed !== '' && !Number.isNaN(num) && num >= 0 ? num : undefined;
    } else if (rowSpec.key === 'title') {
      updated.title = trimmed || autoCompleteTitle(updated, updated.type);
    } else if (rowSpec.key === 'freeText') {
      updated.freeText = trimmed;
    } else {
      (updated as Record<string, unknown>)[rowSpec.key] = trimmed || undefined;
    }

    setEditingCell(null);
    setEditingCellValue('');

    await dbSaveLog(updated);
    setLogs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    showToast(`「${rowSpec.label}」を更新しました`);
  };

  // Excelエクスポート（全件 または 現在の絞り込み結果）
  const handleExportExcel = (targetLogs: GrowthLog[], suffix = '') => {
    const blob = generateGrowthLogExcel(targetLogs);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Personal_Growth_Log_${todayStr()}${suffix}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`分析用Excel（3シート構成・計 ${targetLogs.length} 件）を出力しました`);
  };

  // JSONバックアップ出力 / 復元
  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Personal_Growth_Log_Backup_${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('JSONバックアップを保存しました');
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!Array.isArray(parsed)) throw new Error('Invalid format');
        await dbClearAndSeed(parsed);
        setLogs(parsed);
        const importedTags: string[] = [];
        parsed.forEach((l: GrowthLog) => l.tags?.forEach((t) => importedTags.push(t)));
        registerNewTags(importedTags);
        showToast(`${parsed.length}件のログを復元しました`);
      } catch {
        showToast('JSONファイルの形式が正しくありません', 'info');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // 期間プリセット適用（「全期間」「今日」「直近7日」「今月」のみ、「先月」は削除）
  const applyDatePreset = (preset: 'all' | 'today' | '7days' | 'thisMonth') => {
    if (preset === 'all') {
      setDateFrom('');
      setDateTo('');
      return;
    }
    if (preset === 'today') {
      const t = todayStr();
      setDateFrom(t);
      setDateTo(t);
      return;
    }
    if (preset === '7days') {
      setDateFrom(daysAgoStr(6));
      setDateTo(todayStr());
      return;
    }
    if (preset === 'thisMonth') {
      const d = new Date();
      const first = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      setDateFrom(first);
      setDateTo(todayStr());
    }
  };

  // 全タグ一覧と付与件数（0件のタグも含めて算出）
  const allTagsWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    registeredTags.forEach((t) => counts.set(t, 0));
    logs.forEach((l) => {
      l.tags.forEach((t) => {
        counts.set(t, (counts.get(t) || 0) + 1);
      });
    });
    return Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [logs, registeredTags]);

  // 定義済みタグ名リスト（件数順）
  const selectableTags = useMemo(
    () => allTagsWithCounts.map(([tag]) => tag),
    [allTagsWithCounts]
  );

  // 「記録」フォーム内で定義済みタグをクリック選択（追加・解除トグル）
  const handleToggleTagInForm = useCallback((tag: string) => {
    setFormTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }, []);

  // 「一覧・Excelプレビュー」のセル編集内で定義済みタグをクリック選択（追加・解除トグル）
  const handleToggleTagInCellEditor = useCallback((tag: string) => {
    setEditingCellValue((prev) => {
      const currentList = prev
        .split(/[,\s、]+/)
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean);
      const exists = currentList.includes(tag);
      const nextList = exists
        ? currentList.filter((t) => t !== tag)
        : [...currentList, tag];
      return nextList.join(', ');
    });
  }, []);

  // 共通フィルタ（日付・タグ・キーワード）を通過したログ（右端に最新データが来るよう日付昇順ソート）
  const baseFilteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs
      .filter((log) => {
        if (selectedTag !== 'ALL' && !log.tags.includes(selectedTag)) return false;
        if (dateFrom && log.date < dateFrom) return false;
        if (dateTo && log.date > dateTo) return false;
        if (!q) return true;

        const searchable = [
          log.date,
          log.title,
          log.freeText,
          log.tags.join(' '),
          log.workDetails,
          log.workBottleneck,
          log.workLearnings,
          log.workNextAction,
          log.studyCategory,
          log.studyContent,
          log.studyMethod,
          log.studySolvedProblems,
          log.studyUnderstoodConcepts,
          log.studyArtifacts,
          log.studyQuestions,
          log.studyQuestionResolutionNote,
          log.selfObservedFact,
          log.selfThought,
          log.selfHypothesis,
          log.selfNextAction,
          log.selfHypothesisVerificationNote,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        return searchable.includes(q);
      })
      .sort((a, b) => {
        const cmp = a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);
        return cmp; // 常に左が古く、右端が最新データになる昇順
      });
  }, [logs, selectedTag, dateFrom, dateTo, searchQuery]);

  // 各シート別のフィルタ後件数
  const filteredSheetCounts = useMemo(() => {
    return {
      all: baseFilteredLogs.length,
      work: baseFilteredLogs.filter((l) => l.type === 'work').length,
      study: baseFilteredLogs.filter((l) => l.type === 'study').length,
      self: baseFilteredLogs.filter((l) => l.type === 'self').length,
    };
  }, [baseFilteredLogs]);

  // 現在選択されているプレビューシートのログ
  const currentSheetLogs = useMemo(() => {
    if (previewSheet === 'all') return baseFilteredLogs;
    return baseFilteredLogs.filter((l) => l.type === previewSheet);
  }, [baseFilteredLogs, previewSheet]);

  // 縦持ち表示用: 日付（1列＝1日）ごとのグループ化（左＝古い日付 → 右＝最新の日付）
  const dateColumns = useMemo(() => {
    const map = new Map<string, GrowthLog[]>();
    for (const log of currentSheetLogs) {
      const list = map.get(log.date) || [];
      list.push(log);
      map.set(log.date, list);
    }
    return Array.from(map.entries()).map(([date, dayLogs]) => ({
      date,
      label: formatDateWithWeekday(date),
      logs: dayLogs,
    }));
  }, [currentSheetLogs]);

  // 現在のシートに対応する縦持ち行定義
  const currentMatrixRows = useMemo<MatrixRowSpec[]>(() => {
    if (previewSheet === 'work') return WORK_MATRIX_ROWS;
    if (previewSheet === 'study') return STUDY_MATRIX_ROWS;
    if (previewSheet === 'self') return SELF_MATRIX_ROWS;
    return ALL_SUMMARY_MATRIX_ROWS;
  }, [previewSheet]);

  // テーブルの横幅計測 & 右端（最新データ側）への自動スクロール
  useEffect(() => {
    if (activeTab !== 'spreadsheet') return;
    const updateWidthAndScrollRight = () => {
      if (tableElementRef.current) {
        setTableScrollWidth(tableElementRef.current.scrollWidth);
      }
      if (tableScrollRef.current) {
        const maxScrollLeft = tableScrollRef.current.scrollWidth - tableScrollRef.current.clientWidth;
        tableScrollRef.current.scrollLeft = maxScrollLeft > 0 ? maxScrollLeft : 0;
      }
      if (topScrollRef.current && tableScrollRef.current) {
        topScrollRef.current.scrollLeft = tableScrollRef.current.scrollLeft;
      }
    };
    const timer = setTimeout(updateWidthAndScrollRight, 40);
    window.addEventListener('resize', updateWidthAndScrollRight);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWidthAndScrollRight);
    };
  }, [activeTab, previewSheet, dateColumns]);

  const handleTopBarScroll = () => {
    if (isSyncingScroll.current) return;
    isSyncingScroll.current = true;
    if (topScrollRef.current && tableScrollRef.current) {
      tableScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
    requestAnimationFrame(() => {
      isSyncingScroll.current = false;
    });
  };

  const handleTableContainerScroll = () => {
    if (isSyncingScroll.current) return;
    isSyncingScroll.current = true;
    if (topScrollRef.current && tableScrollRef.current) {
      topScrollRef.current.scrollLeft = tableScrollRef.current.scrollLeft;
    }
    requestAnimationFrame(() => {
      isSyncingScroll.current = false;
    });
  };

  const scrollHorizontalBy = (delta: number) => {
    if (tableScrollRef.current) {
      tableScrollRef.current.scrollBy({ left: delta, behavior: 'smooth' });
    }
  };

  // 統計・集計サマリー（活動指標と成果の分離集計、および未解決/解決済みの分離集計）
  const stats = useMemo(() => {
    const workCount = logs.filter((l) => l.type === 'work').length;
    const studyLogs = logs.filter((l) => l.type === 'study');
    const selfLogs = logs.filter((l) => l.type === 'self');

    const totalStudyMinutes = studyLogs.reduce((acc, l) => acc + (l.studyMinutes || 0), 0);
    const outcomesCount = studyLogs.filter(
      (l) => l.studyUnderstoodConcepts?.trim() || l.studySolvedProblems?.trim() || l.studyArtifacts?.trim()
    ).length;

    const unresolvedQuestions = studyLogs.filter(
      (l) => Boolean(l.studyQuestions?.trim()) && !l.studyQuestionResolved
    );
    const resolvedQuestions = studyLogs.filter(
      (l) => Boolean(l.studyQuestions?.trim()) && Boolean(l.studyQuestionResolved)
    );

    const activeHypotheses = selfLogs.filter(
      (l) => Boolean(l.selfHypothesis?.trim()) && !l.selfHypothesisVerified
    );
    const verifiedHypotheses = selfLogs.filter(
      (l) => Boolean(l.selfHypothesis?.trim()) && Boolean(l.selfHypothesisVerified)
    );

    const byCategory = new Map<
      string,
      { minutes: number; sessions: number; outcomes: number; openQuestions: number }
    >();
    studyLogs.forEach((l) => {
      const cat = l.studyCategory?.trim() || '未分類';
      const cur = byCategory.get(cat) || { minutes: 0, sessions: 0, outcomes: 0, openQuestions: 0 };
      cur.minutes += l.studyMinutes || 0;
      cur.sessions += 1;
      if (l.studyUnderstoodConcepts?.trim() || l.studySolvedProblems?.trim() || l.studyArtifacts?.trim()) {
        cur.outcomes += 1;
      }
      if (l.studyQuestions?.trim() && !l.studyQuestionResolved) {
        cur.openQuestions += 1;
      }
      byCategory.set(cat, cur);
    });

    return {
      total: logs.length,
      workCount,
      studyCount: studyLogs.length,
      selfCount: selfLogs.length,
      totalStudyMinutes,
      outcomesCount,
      unresolvedQuestions,
      resolvedQuestions,
      activeHypotheses,
      verifiedHypotheses,
      categories: Array.from(byCategory.entries()),
    };
  }, [logs]);

  const hasActiveFilters = Boolean(searchQuery.trim() || selectedTag !== 'ALL' || dateFrom || dateTo);
  const firebaseActive = isFirebaseConfigured();

  // 縦持ちテーブル内の各セル描画（ダブルクリックで直接編集可能）
  const renderEditableMatrixCell = (log: GrowthLog, rowSpec: MatrixRowSpec) => {
    const isEditingThis =
      editingCell?.logId === log.id && editingCell?.fieldKey === rowSpec.key;

    if (rowSpec.inputType === 'boolean') {
      if (rowSpec.key === 'studyQuestionResolved') {
        if (!log.studyQuestions?.trim()) {
          return <span className="text-slate-300 dark:text-slate-600">-</span>;
        }
        return (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                log.studyQuestionResolved
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                  : 'bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300'
              }`}
            >
              {log.studyQuestionResolved ? '✓ 解決済み' : '未解決'}
            </span>
            <button
              type="button"
              onClick={() => handleToggleQuestionResolved(log, !log.studyQuestionResolved)}
              className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border transition-colors ${
                log.studyQuestionResolved
                  ? 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  : 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100'
              }`}
            >
              {log.studyQuestionResolved ? (
                <>
                  <RotateCcw className="w-3 h-3" /> 未解決に戻す
                </>
              ) : (
                <>
                  <Check className="w-3 h-3" /> 解決済みにする
                </>
              )}
            </button>
          </div>
        );
      }

      if (rowSpec.key === 'selfHypothesisVerified') {
        if (!log.selfHypothesis?.trim()) {
          return <span className="text-slate-300 dark:text-slate-600">-</span>;
        }
        return (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                log.selfHypothesisVerified
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
              }`}
            >
              {log.selfHypothesisVerified ? '✓ 検証完了' : '検証中'}
            </span>
            <button
              type="button"
              onClick={() => handleToggleHypothesisVerified(log, !log.selfHypothesisVerified)}
              className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border transition-colors ${
                log.selfHypothesisVerified
                  ? 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  : 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100'
              }`}
            >
              {log.selfHypothesisVerified ? (
                <>
                  <RotateCcw className="w-3 h-3" /> 検証中に戻す
                </>
              ) : (
                <>
                  <Check className="w-3 h-3" /> 検証完了にする
                </>
              )}
            </button>
          </div>
        );
      }
    }

    if (isEditingThis) {
      const activeCellTags =
        rowSpec.key === 'tags'
          ? new Set(
              editingCellValue
                .split(/[,\s、]+/)
                .map((t) => t.replace(/^#/, '').trim())
                .filter(Boolean)
            )
          : null;

      return (
        <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {rowSpec.inputType === 'textarea' ? (
            <textarea
              autoFocus
              rows={3}
              value={editingCellValue}
              onChange={(e) => setEditingCellValue(e.target.value)}
              onBlur={() => commitCellEditing(log, rowSpec)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingCell(null);
                  setEditingCellValue('');
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  commitCellEditing(log, rowSpec);
                }
              }}
              placeholder={rowSpec.placeholder}
              className="w-full rounded-lg border border-indigo-400 dark:border-indigo-500 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs leading-relaxed text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          ) : (
            <input
              autoFocus
              type={rowSpec.inputType === 'number' ? 'number' : 'text'}
              min={rowSpec.inputType === 'number' ? 0 : undefined}
              value={editingCellValue}
              onChange={(e) => setEditingCellValue(e.target.value)}
              onBlur={() => commitCellEditing(log, rowSpec)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingCell(null);
                  setEditingCellValue('');
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  commitCellEditing(log, rowSpec);
                }
              }}
              placeholder={rowSpec.placeholder}
              className="w-full rounded-lg border border-indigo-400 dark:border-indigo-500 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          )}

          {/* タグ編集時：定義済みタグ一覧からクリックで追加・解除 */}
          {rowSpec.key === 'tags' && selectableTags.length > 0 && (
            <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 space-y-1.5">
              <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>定義済みタグから選択（クリックで追加・解除）</span>
                <span>{activeCellTags ? activeCellTags.size : 0}個選択中</span>
              </div>
              <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto pr-0.5">
                {selectableTags.map((tag) => {
                  const selected = activeCellTags?.has(tag) ?? false;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault(); // inputのonBlur発火を防止
                        handleToggleTagInCellEditor(tag);
                      }}
                      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                        selected
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                          : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-indigo-400'
                      }`}
                    >
                      {selected ? <Check className="w-2.5 h-2.5" /> : <span>+</span>}
                      <span>#{tag}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setEditingCell(null);
                setEditingCellValue('');
              }}
              className="px-2 py-0.5 rounded text-[11px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              キャンセル
            </button>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commitCellEditing(log, rowSpec);
              }}
              className="px-2.5 py-0.5 rounded bg-indigo-600 text-white text-[11px] font-medium hover:bg-indigo-500"
            >
              保存
            </button>
          </div>
        </div>
      );
    }

    if (rowSpec.key === 'tags') {
      return (
        <div
          onDoubleClick={() => startCellEditing(log, rowSpec)}
          title="ダブルクリックしてタグを編集"
          className="min-h-[24px] cursor-text rounded px-1 -mx-1 py-0.5 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors"
        >
          {log.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {log.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedTag(selectedTag === t ? 'ALL' : t);
                  }}
                  className={`text-[11px] px-1.5 py-0.5 rounded border transition-colors ${
                    selectedTag === t
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-400'
                  }`}
                >
                  #<HighlightedText text={t} query={searchQuery} />
                </button>
              ))}
            </div>
          ) : (
            <span className="text-slate-300 dark:text-slate-600 text-xs">- (ダブルクリックで編集)</span>
          )}
        </div>
      );
    }

    if (rowSpec.key === 'studyMinutes') {
      return (
        <div
          onDoubleClick={() => startCellEditing(log, rowSpec)}
          title="ダブルクリックして学習時間を編集"
          className="min-h-[24px] cursor-text rounded px-1 -mx-1 py-0.5 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors font-mono font-semibold text-sky-700 dark:text-sky-300"
        >
          {log.studyMinutes !== undefined ? (
            `${log.studyMinutes} 分`
          ) : (
            <span className="text-slate-300 dark:text-slate-600 font-sans font-normal">-</span>
          )}
        </div>
      );
    }

    const rawText = log[rowSpec.key as keyof GrowthLog];
    const displayValue = typeof rawText === 'string' ? rawText : '';

    return (
      <div
        onDoubleClick={() => startCellEditing(log, rowSpec)}
        title="ダブルクリックして編集"
        className={`min-h-[24px] cursor-text rounded px-1 -mx-1 py-0.5 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors whitespace-pre-wrap break-words leading-relaxed ${
          rowSpec.key === 'title' ? 'font-semibold text-slate-900 dark:text-slate-100' : ''
        }`}
      >
        <HighlightedText text={displayValue} query={searchQuery} />
      </div>
    );
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-200">
        {/* トースト通知 */}
        {toast && (
          <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium shadow-xl border border-slate-700 dark:border-slate-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 dark:text-emerald-600 shrink-0" />
            <span>{toast.text}</span>
          </div>
        )}

        {/* トップヘッダー */}
        <header className="sticky top-0 z-30 backdrop-blur-md bg-white/85 dark:bg-slate-900/85 border-b border-slate-200 dark:border-slate-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-slate-900 dark:bg-slate-100 flex items-center justify-center text-white dark:text-slate-900 font-bold shadow-sm">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                    Personal Growth Log
                  </h1>
                  <span
                    className={`hidden md:inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${
                      firebaseActive
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {firebaseActive ? (
                      <>
                        <Cloud className="w-3 h-3" /> Firestore + IndexedDB
                      </>
                    ) : (
                      <>
                        <Database className="w-3 h-3" /> Local IndexedDB
                      </>
                    )}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  活動量と成果の分離・事実と仮説の分離に基づく自己成長データベース
                </p>
              </div>
            </div>

            {/* ナビゲーション & アクション */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex rounded-xl bg-slate-100 dark:bg-slate-800 p-1 border border-slate-200/80 dark:border-slate-700">
                <button
                  type="button"
                  onClick={() => setActiveTab('record')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                    activeTab === 'record'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <FilePlus2 className="w-3.5 h-3.5" />
                  記録
                  {editingId && (
                    <span className="ml-1 px-1.5 py-0.2 rounded-full bg-amber-500 text-white text-[10px]">
                      編集中
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('spreadsheet')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                    activeTab === 'spreadsheet'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Table className="w-3.5 h-3.5" />
                  一覧・Excelプレビュー
                  <span className="ml-0.5 text-[11px] px-1.5 py-0.2 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                    {logs.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('insights')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                    activeTab === 'insights'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  振り返り・集計
                </button>
              </div>

              <button
                type="button"
                onClick={() => handleExportExcel(logs)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-semibold shadow-sm transition-colors"
                title="業務ログ・学習ログ・自己観察ログの3シート構成Excel(.xlsx)を出力"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>3シートExcel出力 (.xlsx)</span>
              </button>

              <button
                type="button"
                onClick={() => setDarkMode(!darkMode)}
                className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title="テーマ切替"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </header>

        {/* メインコンテンツ */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
          {/* 上部ステータスバー */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>総記録数 (ローカルDB)</span>
                <Database className="w-4 h-4 text-slate-400" />
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight">{stats.total}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  業務 {stats.workCount} / 学習 {stats.studyCount} / 自己観察 {stats.selfCount}
                </span>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>学習の活動量 (累計時間)</span>
                <Activity className="w-4 h-4 text-sky-500" />
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-sky-600 dark:text-sky-400">
                  {stats.totalStudyMinutes}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  分 ({(stats.totalStudyMinutes / 60).toFixed(1)} 時間)
                </span>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>成果の手掛かり記録数</span>
                <Award className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
                  {stats.outcomesCount}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  件 (概念理解・問題解決・実装)
                </span>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>未解決の疑問 / 検証中の自己仮説</span>
                <HelpCircle className="w-4 h-4 text-amber-500" />
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
                  {stats.unresolvedQuestions.length} / {stats.activeHypotheses.length}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  解決済 {stats.resolvedQuestions.length}・完了 {stats.verifiedHypotheses.length}
                </span>
              </div>
            </div>
          </section>

          {/* ================================================================
              TAB 1: 記録（新規登録・編集専用の独立ページ）
          ================================================================ */}
          {activeTab === 'record' && (
            <div className="max-w-3xl mx-auto space-y-5">
              {/* 直近保存完了バナー */}
              {lastSavedLog && !editingId && (
                <div className="bg-emerald-50/90 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 rounded-2xl px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 shadow-sm">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <div className="text-xs sm:text-sm min-w-0">
                      <span className="font-bold text-emerald-900 dark:text-emerald-200">
                        保存完了：
                      </span>
                      <span className="text-emerald-800 dark:text-emerald-300 truncate ml-1">
                        [{TYPE_META[lastSavedLog.type].shortLabel}] {lastSavedLog.date} 「{lastSavedLog.title}」
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewSheet(lastSavedLog.type);
                        setActiveTab('spreadsheet');
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
                    >
                      <Table className="w-3.5 h-3.5" />
                      Excelプレビューで確認する
                    </button>
                    <button
                      type="button"
                      onClick={() => setLastSavedLog(null)}
                      className="p-1 text-emerald-700 dark:text-emerald-400 hover:opacity-75"
                      title="閉じる"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* 記録入力カード */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                {/* フォームヘッダー */}
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-900/50">
                  <div className="flex items-center gap-2.5">
                    {editingId ? (
                      <>
                        <Edit3 className="w-4 h-4 text-amber-500" />
                        <h2 className="font-bold text-base text-slate-900 dark:text-white">
                          記録の編集モード
                        </h2>
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                        <h2 className="font-bold text-base text-slate-900 dark:text-white">
                          新規ログ記録（入力専用画面）
                        </h2>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {editingId && (
                      <button
                        type="button"
                        onClick={() => resetForm(true)}
                        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800"
                      >
                        <RotateCcw className="w-3 h-3" /> 新規入力へ戻す
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveTab('spreadsheet')}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline px-2 py-1"
                    >
                      <Table className="w-3.5 h-3.5" />
                      過去の記録を検索・プレビュー
                    </button>
                  </div>
                </div>

                <form onSubmit={handleSave} className="p-6 space-y-5">
                  {/* 1. 記録種別セレクタ & 日付 */}
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                    <div className="md:col-span-8">
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                        記録種別 <span className="text-rose-500">*</span>
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {(['study', 'work', 'self'] as LogType[]).map((t) => {
                          const meta = TYPE_META[t];
                          const Icon = meta.icon;
                          const active = formType === t;
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setFormType(t)}
                              className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-xs sm:text-sm font-semibold transition-all ${
                                active
                                  ? `${meta.badgeBg} ${meta.badgeText} ring-2 ring-offset-1 ring-slate-900/10 dark:ring-white/15`
                                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                              }`}
                            >
                              <Icon className="w-4 h-4" />
                              <span>{meta.shortLabel}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="md:col-span-4">
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                        日付 <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="date"
                        required
                        value={formDate}
                        onChange={(e) => setFormDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-600"
                      />
                    </div>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/40 px-3.5 py-2 rounded-xl border border-slate-200/60 dark:border-slate-800">
                    {TYPE_META[formType].description}
                  </p>

                  {/* 2. タイトル（任意・自動補完対応） */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                        タイトル <span className="text-[11px] font-normal text-slate-400">(任意・未入力時は本文から自動生成)</span>
                      </label>
                    </div>
                    <input
                      type="text"
                      placeholder="空欄のままでも保存できます（入力内容の先頭から自動補完）"
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3.5 py-2.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-600"
                    />
                  </div>

                  {/* 3. 種別ごとの固有フィールド */}
                  {formType === 'study' && (
                    <div className="space-y-4">
                      {/* 活動量セクション */}
                      <div className="rounded-xl border border-sky-200/80 dark:border-sky-900/70 bg-sky-50/40 dark:bg-sky-950/20 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-800 dark:text-sky-300">
                            <Activity className="w-3.5 h-3.5" />
                            1. 活動指標（インプット量・行動）
                          </span>
                          <span className="text-[11px] text-sky-700/70 dark:text-sky-400/70">
                            どれか1つでも入力すれば保存可能
                          </span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                              学習分野
                            </label>
                            <input
                              type="text"
                              placeholder="例: 統計, SQL, DBスペシャリスト"
                              value={studyCategory}
                              onChange={(e) => setStudyCategory(e.target.value)}
                              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                              学習時間 (分)
                            </label>
                            <input
                              type="number"
                              min={0}
                              step={5}
                              placeholder="例: 60"
                              value={studyMinutes}
                              onChange={(e) => setStudyMinutes(e.target.value)}
                              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                              学習方法
                            </label>
                            <input
                              type="text"
                              placeholder="例: 過去問演習, 書籍, 実装"
                              value={studyMethod}
                              onChange={(e) => setStudyMethod(e.target.value)}
                              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            学習内容（取り組んだ範囲・テーマ）
                          </label>
                          <textarea
                            rows={2}
                            placeholder="何について学習・演習したか"
                            value={studyContent}
                            onChange={(e) => setStudyContent(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                          />
                        </div>
                      </div>

                      {/* 成果の手掛かりセクション */}
                      <div className="rounded-xl border border-emerald-200/80 dark:border-emerald-900/70 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-300">
                            <Award className="w-3.5 h-3.5" />
                            2. 成果の手掛かり（アウトプット・構造理解）
                          </span>
                          <span className="text-[11px] text-emerald-700/70 dark:text-emerald-400/70">
                            活動時間とは明確に区別して記録
                          </span>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            理解できた概念・仕組み（「なぜそうなるか」の言語化）
                          </label>
                          <textarea
                            rows={2}
                            placeholder="自分の言葉で説明できるようになった仕組み・因果関係"
                            value={studyUnderstoodConcepts}
                            onChange={(e) => setStudyUnderstoodConcepts(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                          />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                              解けた問題・演習
                            </label>
                            <textarea
                              rows={2}
                              placeholder="自力で解けた問題やテストケース"
                              value={studySolvedProblems}
                              onChange={(e) => setStudySolvedProblems(e.target.value)}
                              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                              自力で実装できたもの・成果物
                            </label>
                            <textarea
                              rows={2}
                              placeholder="書いたコード、クエリ、整理図など"
                              value={studyArtifacts}
                              onChange={(e) => setStudyArtifacts(e.target.value)}
                              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                            />
                          </div>
                        </div>
                      </div>

                      {/* 未解決の疑問 + 解決済みチェック */}
                      <div className="rounded-xl border border-rose-200/70 dark:border-rose-900/60 bg-rose-50/30 dark:bg-rose-950/15 p-3.5 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-1.5 text-xs font-bold text-rose-700 dark:text-rose-300">
                            <HelpCircle className="w-3.5 h-3.5" />
                            3. 未解決の疑問（深掘りしすぎ防止用の疑問ストック）
                          </label>
                          {studyQuestions.trim().length > 0 && (
                            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 cursor-pointer select-none bg-white dark:bg-slate-900 px-2.5 py-1 rounded-lg border border-emerald-300 dark:border-emerald-800">
                              <input
                                type="checkbox"
                                checked={studyQuestionResolved}
                                onChange={(e) => setStudyQuestionResolved(e.target.checked)}
                                className="rounded text-emerald-600 focus:ring-emerald-500"
                              />
                              <span>解決済みとして記録する（未解決リストから消す）</span>
                            </label>
                          )}
                        </div>
                        <textarea
                          rows={2}
                          placeholder="今すぐ深掘りせず一旦保留にした疑問・次回確認したい点"
                          value={studyQuestions}
                          onChange={(e) => setStudyQuestions(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                        {studyQuestions.trim().length > 0 && studyQuestionResolved && (
                          <div>
                            <label className="block text-[11px] font-medium text-emerald-700 dark:text-emerald-300 mb-1">
                              解決メモ（どのように解決したか・結論）
                            </label>
                            <input
                              type="text"
                              placeholder="例: 公式ドキュメントのロック範囲仕様を確認して解決"
                              value={studyQuestionResolutionNote}
                              onChange={(e) => setStudyQuestionResolutionNote(e.target.value)}
                              className="w-full rounded-lg border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs sm:text-sm"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {formType === 'work' && (
                    <div className="rounded-xl border border-blue-200/80 dark:border-blue-900/70 bg-blue-50/30 dark:bg-blue-950/20 p-4 space-y-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-800 dark:text-blue-300">
                        <Briefcase className="w-3.5 h-3.5" />
                        業務ログ項目（すべて任意・書ける項目のみでOK）
                      </span>

                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                          取り組んだこと（事実・タスク）
                        </label>
                        <textarea
                          rows={2}
                          placeholder="今日進めた業務・実装・分析作業"
                          value={workDetails}
                          onChange={(e) => setWorkDetails(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                          詰まったこと・判断に迷ったこと（ボトルネック）
                        </label>
                        <textarea
                          rows={2}
                          placeholder="仕様確認や設計判断で迷ったポイント、時間がかかった箇所"
                          value={workBottleneck}
                          onChange={(e) => setWorkBottleneck(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            得られた知見・学び
                          </label>
                          <textarea
                            rows={2}
                            placeholder="再利用できる知識・気づき"
                            value={workLearnings}
                            onChange={(e) => setWorkLearnings(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            次に生かすこと（Next Action）
                          </label>
                          <textarea
                            rows={2}
                            placeholder="次回から実践する具体的な工夫・チェック項目"
                            value={workNextAction}
                            onChange={(e) => setWorkNextAction(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {formType === 'self' && (
                    <div className="rounded-xl border border-amber-200/80 dark:border-amber-900/70 bg-amber-50/30 dark:bg-amber-950/20 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-300">
                          <Eye className="w-3.5 h-3.5" />
                          事実と仮説の分離（断定的なラベル貼りを避け、検証可能な仮説として扱う）
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                          1. 観察した事実（客観的な行動・状況・経過時間）
                        </label>
                        <textarea
                          rows={2}
                          placeholder="評価を交えず、実際に起きた出来事や行動を記述"
                          value={selfObservedFact}
                          onChange={(e) => setSelfObservedFact(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                          2. そのときの考え・感情（内面の反応）
                        </label>
                        <textarea
                          rows={2}
                          placeholder="その瞬間に頭の中で何を考えていたか"
                          value={selfThought}
                          onChange={(e) => setSelfThought(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                      </div>

                      <div className="rounded-lg border border-amber-200/90 dark:border-amber-800/70 bg-white/70 dark:bg-slate-900/50 p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="block text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                            3. 自分についての仮説（「〜という条件では〜になりやすいのではないか」）
                          </label>
                          {selfHypothesis.trim().length > 0 && (
                            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 cursor-pointer select-none bg-white dark:bg-slate-900 px-2.5 py-1 rounded-lg border border-emerald-300 dark:border-emerald-800">
                              <input
                                type="checkbox"
                                checked={selfHypothesisVerified}
                                onChange={(e) => setSelfHypothesisVerified(e.target.checked)}
                                className="rounded text-emerald-600 focus:ring-emerald-500"
                              />
                              <span>検証完了として記録する（検証中リストから消す）</span>
                            </label>
                          )}
                        </div>
                        <textarea
                          rows={2}
                          placeholder="性格の断定ではなく、トリガーと反応に関する暫定仮説"
                          value={selfHypothesis}
                          onChange={(e) => setSelfHypothesis(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                        {selfHypothesis.trim().length > 0 && selfHypothesisVerified && (
                          <div>
                            <label className="block text-[11px] font-medium text-emerald-700 dark:text-emerald-300 mb-1">
                              検証結果メモ（実験してみてどうだったか）
                            </label>
                            <input
                              type="text"
                              placeholder="例: 15分タイマーを導入した結果、予定時間内に演習1周を完了できた"
                              value={selfHypothesisVerificationNote}
                              onChange={(e) => setSelfHypothesisVerificationNote(e.target.value)}
                              className="w-full rounded-lg border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs sm:text-sm"
                            />
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 mb-1">
                          4. 次に試すこと（小さな検証実験）
                        </label>
                        <textarea
                          rows={2}
                          placeholder="仮説を検証するために次回試す具体的な行動・環境設定"
                          value={selfNextAction}
                          onChange={(e) => setSelfNextAction(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs sm:text-sm"
                        />
                      </div>
                    </div>
                  )}

                  {/* 4. 自由記述・補足メモ */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                      自由記述・本文メモ <span className="text-[11px] font-normal text-slate-400">(ここだけの記入でも保存可能)</span>
                    </label>
                    <textarea
                      rows={3}
                      placeholder="構造化項目に収まらないメモや、素早い一行記録として自由に入力できます"
                      value={formFreeText}
                      onChange={(e) => setFormFreeText(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3.5 py-2.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-600"
                    />
                  </div>

                  {/* 5. タグ（任意：手入力＋定義済みタグからクリック選択） */}
                  <div className="space-y-2.5">
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400">
                      タグ <span className="text-[11px] font-normal text-slate-400">(任意・手入力で新規追加、または下の定義済みタグから選択)</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="新しいタグを手入力 (例: SQL, 因果推論) ※Enterまたはカンマで追加"
                        value={formTagInput}
                        onChange={(e) => setFormTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            handleAddTag(formTagInput);
                          }
                        }}
                        className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3 py-2 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddTag(formTagInput)}
                        className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-xs font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                      >
                        手入力を追加
                      </button>
                    </div>

                    {/* 現在この記録に選択されているタグ一覧 */}
                    {formTags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mr-1">
                          選択中 ({formTags.length}):
                        </span>
                        {formTags.map((t) => (
                          <span
                            key={t}
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-600 text-white shadow-sm"
                          >
                            #{t}
                            <button
                              type="button"
                              onClick={() => handleRemoveTagFromForm(t)}
                              className="text-indigo-200 hover:text-white"
                              title="選択解除"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* 定義済みタグからクリックで選択（トグル） */}
                    {selectableTags.length > 0 && (
                      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                            <Tag className="w-3 h-3" />
                            定義済みタグからクリックで選択（再クリックで解除）
                          </span>
                          <span className="text-[11px] text-slate-400">
                            全 {selectableTags.length} 個
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {selectableTags
                            .filter((tag) => {
                              const q = formTagInput.trim().replace(/^#/, '').toLowerCase();
                              if (!q) return true;
                              return true;
                            })
                            .sort((a, b) => {
                              const q = formTagInput.trim().replace(/^#/, '').toLowerCase();
                              if (!q) return 0;
                              const aMatch = a.toLowerCase().includes(q) ? 0 : 1;
                              const bMatch = b.toLowerCase().includes(q) ? 0 : 1;
                              return aMatch - bMatch;
                            })
                            .map((tag) => {
                              const isSelected = formTags.includes(tag);
                              const q = formTagInput.trim().replace(/^#/, '').toLowerCase();
                              const isInputMatched = Boolean(q && tag.toLowerCase().includes(q));
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => handleToggleTagInForm(tag)}
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                                    isSelected
                                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                      : isInputMatched
                                      ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200 border-amber-400 dark:border-amber-600 ring-1 ring-amber-400/50'
                                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400'
                                  }`}
                                >
                                  {isSelected ? (
                                    <Check className="w-3 h-3" />
                                  ) : (
                                    <Plus className="w-3 h-3 text-slate-400" />
                                  )}
                                  <span>#{tag}</span>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 保存ボタン */}
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={!isFormValid}
                      className={`w-full py-3 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-sm ${
                        isFormValid
                          ? 'bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-200 text-white dark:text-slate-900 cursor-pointer'
                          : 'bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                      }`}
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{editingId ? '変更を保存する' : 'ログを記録する'}</span>
                    </button>
                    {!isFormValid && (
                      <p className="text-[11px] text-center text-slate-400 mt-1.5">
                        ※「自由記述」または「固有項目」のいずれか1つを入力すると保存できます
                      </p>
                    )}
                  </div>
                </form>
              </div>

              {/* 記録画面下部：現在未解決の疑問 & 検証中の自己仮説クイック確認・完了バー */}
              {(stats.unresolvedQuestions.length > 0 || stats.activeHypotheses.length > 0) && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      現在ストック中の「未解決の疑問 / 検証中の自己仮説」（解決・完了にするとここから消えます）
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="text-xs font-bold text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
                        <HelpCircle className="w-3.5 h-3.5" />
                        未解決の疑問 ({stats.unresolvedQuestions.length}件)
                      </div>
                      {stats.unresolvedQuestions.length === 0 ? (
                        <p className="text-xs text-slate-400">未解決の疑問はありません</p>
                      ) : (
                        stats.unresolvedQuestions.slice(0, 3).map((q) => (
                          <div
                            key={q.id}
                            className="p-3 rounded-xl border border-rose-200/70 dark:border-rose-900/50 bg-rose-50/30 dark:bg-rose-950/15 flex items-start justify-between gap-2"
                          >
                            <div className="text-xs space-y-0.5 min-w-0">
                              <div className="text-[11px] text-slate-400 font-mono">{q.date}</div>
                              <p className="text-slate-800 dark:text-slate-200 line-clamp-2">{q.studyQuestions}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleToggleQuestionResolved(q, true)}
                              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold transition-colors"
                              title="解決済みにする"
                            >
                              <Check className="w-3 h-3" /> 解決済みにする
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-bold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" />
                        検証中の自己仮説 ({stats.activeHypotheses.length}件)
                      </div>
                      {stats.activeHypotheses.length === 0 ? (
                        <p className="text-xs text-slate-400">検証中の自己仮説はありません</p>
                      ) : (
                        stats.activeHypotheses.slice(0, 3).map((h) => (
                          <div
                            key={h.id}
                            className="p-3 rounded-xl border border-amber-200/70 dark:border-amber-900/50 bg-amber-50/30 dark:bg-amber-950/15 flex items-start justify-between gap-2"
                          >
                            <div className="text-xs space-y-0.5 min-w-0">
                              <div className="text-[11px] text-slate-400 font-mono">{h.date}</div>
                              <p className="text-slate-800 dark:text-slate-200 line-clamp-2">{h.selfHypothesis}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleToggleHypothesisVerified(h, true)}
                              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold transition-colors"
                              title="検証完了にする"
                            >
                              <Check className="w-3 h-3" /> 検証完了にする
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* バックアップ管理バー */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">データ管理・JSONバックアップ：</span>
                  Firestore およびブラウザ内 IndexedDB に保存されています。
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportJson}
                    className="inline-flex items-center gap-1.5 py-1.5 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    JSON保存
                  </button>
                  <label className="inline-flex items-center gap-1.5 py-1.5 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    JSON復元
                    <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              TAB 2: 一覧・Excelプレビュー（縦持ち1列=1日 + 右端最新 + ダブルクリック編集）
          ================================================================ */}
          {activeTab === 'spreadsheet' && (
            <div className="space-y-4">
              {/* 検索・日付フィルタコントロールパネル */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 shadow-sm space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-end">
                  {/* キーワード検索 */}
                  <div className="lg:col-span-5">
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                      キーワード横断検索（タイトル・本文・全固有項目・タグ）
                    </label>
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="例: Window関数, トランザクション, 仮説, ボトルネック..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-9 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 日付範囲フィルタ */}
                  <div className="lg:col-span-4">
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                      日付・期間で絞り込み
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2.5 py-2 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                      <span className="text-xs text-slate-400">〜</span>
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                        className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2.5 py-2 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                    </div>
                  </div>

                  {/* 期間クイック選択（「先月」は削除） */}
                  <div className="lg:col-span-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400 w-full mb-0.5 flex items-center gap-1">
                      <CalendarRange className="w-3 h-3" /> 期間クイック選択
                    </span>
                    <button
                      type="button"
                      onClick={() => applyDatePreset('all')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        !dateFrom && !dateTo
                          ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 border-transparent'
                          : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      全期間
                    </button>
                    <button
                      type="button"
                      onClick={() => applyDatePreset('today')}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100"
                    >
                      今日
                    </button>
                    <button
                      type="button"
                      onClick={() => applyDatePreset('7days')}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100"
                    >
                      直近7日
                    </button>
                    <button
                      type="button"
                      onClick={() => applyDatePreset('thisMonth')}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100"
                    >
                      今月
                    </button>
                  </div>
                </div>

                {/* タグフィルタ（0件のタグのみ横に「×」を表示して削除可能） */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-1.5 flex-wrap flex-1">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 mr-1">
                      <Tag className="w-3.5 h-3.5" /> タグ絞り込み:
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedTag('ALL')}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        selectedTag === 'ALL'
                          ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200'
                      }`}
                    >
                      すべて
                    </button>
                    {allTagsWithCounts.map(([tag, count]) => {
                      const isSelected = selectedTag === tag;
                      const isZero = count === 0;
                      return (
                        <div
                          key={tag}
                          className={`inline-flex items-center rounded-full text-xs font-medium transition-colors border ${
                            isSelected
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : isZero
                              ? 'bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500 border-dashed border-slate-300 dark:border-slate-700'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-200'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedTag(isSelected ? 'ALL' : tag)}
                            className={`px-2.5 py-1 rounded-full ${isZero ? 'pr-1.5' : ''}`}
                          >
                            #{tag}({count})
                          </button>
                          {isZero && (
                            <button
                              type="button"
                              onClick={(e) => handleDeleteTagFromRegistry(tag, count, e)}
                              title={`付与件数0件のタグ「#${tag}」を削除`}
                              className={`pr-2 pl-0.5 py-1 rounded-r-full transition-colors ${
                                isSelected
                                  ? 'text-indigo-200 hover:text-white'
                                  : 'text-slate-400 hover:text-rose-600 dark:hover:text-rose-400'
                              }`}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setSelectedTag('ALL');
                        setDateFrom('');
                        setDateTo('');
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800 text-xs font-semibold hover:bg-rose-100"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> フィルタをすべて解除
                    </button>
                  )}
                </div>
              </div>

              {/* シート切替タブ（順番: Sheet 1 → Sheet 2 → Sheet 3 → 全種別サマリー表） */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                <div className="px-4 sm:px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setPreviewSheet('work')}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                        previewSheet === 'work'
                          ? 'bg-blue-700 text-white border-blue-700 shadow-sm'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-blue-950/40'
                      }`}
                    >
                      <Briefcase className="w-3.5 h-3.5" />
                      Sheet 1: 業務ログ ({filteredSheetCounts.work})
                    </button>

                    <button
                      type="button"
                      onClick={() => setPreviewSheet('study')}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                        previewSheet === 'study'
                          ? 'bg-emerald-700 text-white border-emerald-700 shadow-sm'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                      }`}
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      Sheet 2: 学習ログ ({filteredSheetCounts.study})
                    </button>

                    <button
                      type="button"
                      onClick={() => setPreviewSheet('self')}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                        previewSheet === 'self'
                          ? 'bg-amber-700 text-white border-amber-700 shadow-sm'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-amber-50 dark:hover:bg-amber-950/40'
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Sheet 3: 自己観察ログ ({filteredSheetCounts.self})
                    </button>

                    <button
                      type="button"
                      onClick={() => setPreviewSheet('all')}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                        previewSheet === 'all'
                          ? 'bg-slate-800 text-white border-slate-800 dark:bg-white dark:text-slate-900 shadow-sm'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      全種別サマリー表 ({filteredSheetCounts.all})
                    </button>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      ※ 各欄をダブルクリックするとその場で直接編集できます
                    </span>
                    {hasActiveFilters && (
                      <button
                        type="button"
                        onClick={() => handleExportExcel(baseFilteredLogs, '_filtered')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 text-xs font-semibold hover:bg-emerald-100"
                      >
                        <Download className="w-3.5 h-3.5" />
                        絞り込み結果のみExcel出力 ({baseFilteredLogs.length}件)
                      </button>
                    )}
                  </div>
                </div>

                {/* ==============================================================
                    表上部の横スクロールバー & スクロール操作バー
                ============================================================== */}
                {dateColumns.length > 0 && (
                  <div className="px-4 py-2 bg-slate-100/90 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => scrollHorizontalBy(-320)}
                        className="p-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50"
                        title="左（過去の日付）へスクロール"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => scrollHorizontalBy(320)}
                        className="p-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50"
                        title="右（最新の日付）へスクロール"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* 上部横スクロールバー本体 */}
                    <div
                      ref={topScrollRef}
                      onScroll={handleTopBarScroll}
                      className="flex-1 overflow-x-auto overflow-y-hidden h-4 rounded bg-slate-200/70 dark:bg-slate-900/70"
                    >
                      <div style={{ width: `${tableScrollWidth}px`, height: '1px' }} />
                    </div>
                  </div>
                )}

                {/* ==============================================================
                    縦持ちExcelプレビューテーブル（1列＝1日 / 右端が最新データ）
                ============================================================== */}
                {isLoading ? (
                  <div className="p-12 text-center text-sm text-slate-400">読み込み中...</div>
                ) : dateColumns.length === 0 ? (
                  <div className="p-12 text-center space-y-3">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      条件に一致する記録がこのシートにありません。
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      {hasActiveFilters && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setSelectedTag('ALL');
                            setDateFrom('');
                            setDateTo('');
                          }}
                          className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          検索・フィルタをリセットする
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveTab('record')}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold"
                      >
                        <Plus className="w-3.5 h-3.5" /> 新規記録を追加する
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    ref={tableScrollRef}
                    onScroll={handleTableContainerScroll}
                    className="overflow-x-auto max-h-[72vh] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                  >
                    <table
                      ref={tableElementRef}
                      className="w-max min-w-full border-collapse text-xs text-left"
                    >
                      <thead className="sticky top-0 z-20">
                        <tr
                          className={
                            previewSheet === 'study'
                              ? 'bg-emerald-900 text-white'
                              : previewSheet === 'work'
                              ? 'bg-blue-900 text-white'
                              : previewSheet === 'self'
                              ? 'bg-amber-900 text-white'
                              : 'bg-slate-800 text-white'
                          }
                        >
                          {/* 左上の固定セル（ラベル表記なし） */}
                          <th className="sticky left-0 z-30 w-[230px] min-w-[230px] max-w-[230px] py-3 px-3.5 font-bold border-r border-b border-white/20 bg-slate-900 text-white shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]" />

                          {/* 各列＝1日（左＝古い日付 → 右＝最新の日付） */}
                          {dateColumns.map((col) => (
                            <th
                              key={col.date}
                              className="w-[320px] min-w-[320px] max-w-[320px] py-2.5 px-3.5 border-r border-b border-white/15 align-top"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-bold text-xs sm:text-sm tracking-tight">
                                  {col.label}
                                </span>
                                {col.logs.length > 1 && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/15 text-white">
                                    {col.logs.length}件
                                  </span>
                                )}
                              </div>

                              {/* 日付の下は「削除（ゴミ箱マーク）」のみ配置 */}
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {col.logs.map((entry, idx) => {
                                  const meta = TYPE_META[entry.type];
                                  return (
                                    <div
                                      key={entry.id}
                                      className="inline-flex items-center gap-1.5 bg-black/25 hover:bg-black/35 rounded-lg px-2 py-1 text-[11px] transition-colors"
                                    >
                                      {previewSheet === 'all' && (
                                        <span className="font-bold text-white/90">
                                          [{meta.shortLabel}]
                                        </span>
                                      )}
                                      {col.logs.length > 1 && (
                                        <span className="text-white/80 font-mono">#{idx + 1}</span>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleDelete(entry.id)}
                                        className="inline-flex items-center gap-0.5 text-rose-200 hover:text-rose-100 font-medium"
                                        title="この記録を削除"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>

                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {currentMatrixRows.map((row) => {
                          const rowHeaderStyle =
                            row.group === 'activity'
                              ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200 border-l-4 border-l-sky-500'
                              : row.group === 'outcome'
                              ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 border-l-4 border-l-emerald-500'
                              : row.group === 'question'
                              ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-900 dark:text-rose-200 border-l-4 border-l-rose-500'
                              : row.group === 'work'
                              ? 'bg-blue-50/70 dark:bg-blue-950/40 text-blue-900 dark:text-blue-200 border-l-4 border-l-blue-500'
                              : row.group === 'self'
                              ? 'bg-amber-50/70 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border-l-4 border-l-amber-500'
                              : 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-l-4 border-l-slate-400';

                          const cellBgStyle =
                            row.group === 'activity'
                              ? 'bg-sky-50/15 dark:bg-sky-950/10'
                              : row.group === 'outcome'
                              ? 'bg-emerald-50/15 dark:bg-emerald-950/10'
                              : row.group === 'question'
                              ? 'bg-rose-50/15 dark:bg-rose-950/10'
                              : 'bg-white dark:bg-slate-900';

                          return (
                            <tr key={row.key} className="group">
                              {/* 左端固定の項目名セル */}
                              <th
                                className={`sticky left-0 z-10 w-[230px] min-w-[230px] max-w-[230px] py-3 px-3.5 font-bold text-xs align-top border-r border-slate-200 dark:border-slate-800 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.06)] ${rowHeaderStyle}`}
                              >
                                {row.label}
                              </th>

                              {/* 日付ごとのデータセル（常に全文折り返し表示 & ダブルクリックで編集） */}
                              {dateColumns.map((col) => (
                                <td
                                  key={`${col.date}-${row.key}`}
                                  className={`w-[320px] min-w-[320px] max-w-[320px] py-3 px-3.5 align-top border-r border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 ${cellBgStyle}`}
                                >
                                  {col.logs.length === 1 ? (
                                    renderEditableMatrixCell(col.logs[0], row)
                                  ) : (
                                    <div className="space-y-2.5 divide-y divide-slate-200/70 dark:divide-slate-800/70">
                                      {col.logs.map((entry, idx) => (
                                        <div key={entry.id} className={idx > 0 ? 'pt-2.5' : ''}>
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                                              #{idx + 1} {TYPE_META[entry.type].shortLabel}
                                            </span>
                                          </div>
                                          {renderEditableMatrixCell(entry, row)}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================================================================
              TAB 3: 振り返り・集計ビュー
          ================================================================ */}
          {activeTab === 'insights' && (
            <div className="space-y-6">
              {/* 1. 学習分野別の活動指標 vs 成果の手掛かり */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-emerald-500" />
                      学習分野別：活動量（時間・回数）と成果の手掛かりの対比
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      単なる勉強時間だけでなく、「概念理解・問題解決・実装物」が伴っているかを点検します
                    </p>
                  </div>
                </div>

                {stats.categories.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4">学習ログがまだありません。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs sm:text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                          <th className="py-2.5 px-3 font-semibold">学習分野</th>
                          <th className="py-2.5 px-3 font-semibold text-sky-600 dark:text-sky-400">
                            [活動量] セッション数
                          </th>
                          <th className="py-2.5 px-3 font-semibold text-sky-600 dark:text-sky-400">
                            [活動量] 累計学習時間
                          </th>
                          <th className="py-2.5 px-3 font-semibold text-emerald-600 dark:text-emerald-400">
                            [成果の手掛かり] 記録数
                          </th>
                          <th className="py-2.5 px-3 font-semibold text-rose-600 dark:text-rose-400">
                            未解決の疑問数
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {stats.categories.map(([cat, val]) => (
                          <tr key={cat} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                            <td className="py-3 px-3 font-semibold text-slate-900 dark:text-white">
                              {cat}
                            </td>
                            <td className="py-3 px-3">{val.sessions} 回</td>
                            <td className="py-3 px-3 font-medium text-sky-700 dark:text-sky-300">
                              {val.minutes} 分 ({(val.minutes / 60).toFixed(1)}h)
                            </td>
                            <td className="py-3 px-3 font-medium text-emerald-700 dark:text-emerald-300">
                              {val.outcomes} / {val.sessions} 件
                            </td>
                            <td className="py-3 px-3 text-rose-600 dark:text-rose-400 font-medium">
                              {val.openQuestions} 件
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 2. 未解決の疑問ストック（解決済みにすると消える仕組み） */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <HelpCircle className="w-4 h-4 text-rose-500" />
                        学習の「未解決の疑問」ストック ({stats.unresolvedQuestions.length}件)
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        「解決済みにする」を押すと未解決リストから消え、Excel出力用の履歴として保持されます
                      </p>
                    </div>
                    {stats.resolvedQuestions.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowResolvedQuestions(!showResolvedQuestions)}
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700"
                      >
                        {showResolvedQuestions
                          ? '解決済みを隠す'
                          : `解決済みを表示 (${stats.resolvedQuestions.length}件)`}
                      </button>
                    )}
                  </div>

                  {stats.unresolvedQuestions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-6 text-center text-xs text-slate-400">
                      現在、未解決の疑問はありません。
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {stats.unresolvedQuestions.map((l) => (
                        <div
                          key={l.id}
                          className="p-3.5 rounded-xl border border-rose-200/70 dark:border-rose-900/50 bg-rose-50/30 dark:bg-rose-950/15 space-y-2"
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span>
                              {l.date} ・ {l.studyCategory || '学習'}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleEdit(l)}
                                className="text-slate-500 hover:text-slate-900 dark:hover:text-white underline"
                              >
                                フォームで編集
                              </button>
                            </div>
                          </div>
                          <p className="text-xs sm:text-sm font-medium text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
                            {l.studyQuestions}
                          </p>

                          {resolvingNoteId === `q-${l.id}` ? (
                            <div className="pt-1 flex flex-col sm:flex-row gap-2">
                              <input
                                type="text"
                                placeholder="解決メモ（任意：どう解決したか）"
                                value={resolvingNoteText}
                                onChange={(e) => setResolvingNoteText(e.target.value)}
                                className="flex-1 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                              />
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleToggleQuestionResolved(l, true, resolvingNoteText)}
                                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                                >
                                  完了確定
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setResolvingNoteId(null);
                                    setResolvingNoteText('');
                                  }}
                                  className="px-2 py-1.5 rounded-lg text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                                >
                                  キャンセル
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between pt-1">
                              <span className="text-[11px] text-slate-400">元ログ: {l.title}</span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setResolvingNoteId(`q-${l.id}`);
                                    setResolvingNoteText(l.studyQuestionResolutionNote || '');
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 text-xs font-medium hover:bg-emerald-50"
                                >
                                  <MessageSquarePlus className="w-3 h-3" /> メモを添えて解決
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleToggleQuestionResolved(l, true)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
                                >
                                  <Check className="w-3.5 h-3.5" /> 解決済みにする
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 解決済み履歴（トグルON時のみ表示） */}
                  {showResolvedQuestions && stats.resolvedQuestions.length > 0 && (
                    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                      <div className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                        解決済みの疑問アーカイブ ({stats.resolvedQuestions.length}件)
                      </div>
                      {stats.resolvedQuestions.map((l) => (
                        <div
                          key={l.id}
                          className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-1 opacity-85"
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span>{l.date} ・ 解決済み</span>
                            <button
                              type="button"
                              onClick={() => handleToggleQuestionResolved(l, false)}
                              className="text-slate-500 hover:text-rose-600 inline-flex items-center gap-1"
                            >
                              <RotateCcw className="w-3 h-3" /> 未解決に戻す
                            </button>
                          </div>
                          <p className="text-xs line-through text-slate-500">{l.studyQuestions}</p>
                          {l.studyQuestionResolutionNote && (
                            <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">
                              解決メモ: {l.studyQuestionResolutionNote}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 3. 自己観察の仮説と検証実験一覧（検証完了にすると消える仕組み） */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Eye className="w-4 h-4 text-amber-500" />
                        検証中の「自分についての仮説」 ({stats.activeHypotheses.length}件)
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        「検証完了にする」を押すと検証中リストから消え、Excel出力用の履歴として保持されます
                      </p>
                    </div>
                    {stats.verifiedHypotheses.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowVerifiedHypotheses(!showVerifiedHypotheses)}
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700"
                      >
                        {showVerifiedHypotheses
                          ? '検証完了を隠す'
                          : `検証完了を表示 (${stats.verifiedHypotheses.length}件)`}
                      </button>
                    )}
                  </div>

                  {stats.activeHypotheses.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-6 text-center text-xs text-slate-400">
                      現在、検証中の自己仮説はありません。
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {stats.activeHypotheses.map((l) => (
                        <div
                          key={l.id}
                          className="p-3.5 rounded-xl border border-amber-200/70 dark:border-amber-900/50 bg-amber-50/30 dark:bg-amber-950/15 space-y-2"
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span>{l.date}</span>
                            <button
                              type="button"
                              onClick={() => handleEdit(l)}
                              className="text-slate-500 hover:text-slate-900 dark:hover:text-white underline"
                            >
                              フォームで編集
                            </button>
                          </div>
                          {l.selfObservedFact && (
                            <p className="text-xs text-slate-600 dark:text-slate-400">
                              <span className="font-semibold">事実:</span> {l.selfObservedFact}
                            </p>
                          )}
                          <p className="text-xs sm:text-sm font-medium text-amber-900 dark:text-amber-200">
                            <span className="font-bold">仮説:</span> {l.selfHypothesis}
                          </p>
                          {l.selfNextAction && (
                            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                              <span className="font-bold">次に試すこと:</span> {l.selfNextAction}
                            </p>
                          )}

                          {resolvingNoteId === `h-${l.id}` ? (
                            <div className="pt-1 flex flex-col sm:flex-row gap-2">
                              <input
                                type="text"
                                placeholder="検証結果メモ（任意：試してみてどうだったか）"
                                value={resolvingNoteText}
                                onChange={(e) => setResolvingNoteText(e.target.value)}
                                className="flex-1 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                              />
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleToggleHypothesisVerified(l, true, resolvingNoteText)}
                                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                                >
                                  完了確定
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setResolvingNoteId(null);
                                    setResolvingNoteText('');
                                  }}
                                  className="px-2 py-1.5 rounded-lg text-xs text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                                >
                                  キャンセル
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5 pt-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setResolvingNoteId(`h-${l.id}`);
                                  setResolvingNoteText(l.selfHypothesisVerificationNote || '');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 text-xs font-medium hover:bg-emerald-50"
                              >
                                <MessageSquarePlus className="w-3 h-3" /> 結果メモを添えて完了
                              </button>
                              <button
                                type="button"
                                onClick={() => handleToggleHypothesisVerified(l, true)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
                              >
                                <Check className="w-3.5 h-3.5" /> 検証完了にする
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 検証完了アーカイブ（トグルON時のみ表示） */}
                  {showVerifiedHypotheses && stats.verifiedHypotheses.length > 0 && (
                    <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                      <div className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                        検証完了した自己仮説アーカイブ ({stats.verifiedHypotheses.length}件)
                      </div>
                      {stats.verifiedHypotheses.map((l) => (
                        <div
                          key={l.id}
                          className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-1 opacity-85"
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span>{l.date} ・ 検証完了</span>
                            <button
                              type="button"
                              onClick={() => handleToggleHypothesisVerified(l, false)}
                              className="text-slate-500 hover:text-amber-600 inline-flex items-center gap-1"
                            >
                              <RotateCcw className="w-3 h-3" /> 検証中に戻す
                            </button>
                          </div>
                          <p className="text-xs line-through text-slate-500">{l.selfHypothesis}</p>
                          {l.selfHypothesisVerificationNote && (
                            <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">
                              検証結果メモ: {l.selfHypothesisVerificationNote}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 4. 業務のボトルネックと再現性知見ストック */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-3">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-blue-500" />
                  業務の詰まりポイント（ボトルネック）と得られた知見・Next Action
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {logs
                    .filter((l) => l.type === 'work' && (l.workBottleneck || l.workLearnings || l.workNextAction))
                    .map((l) => (
                      <div
                        key={l.id}
                        className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <span>{l.date}</span>
                          <span className="font-medium text-slate-600 dark:text-slate-300">{l.title}</span>
                        </div>
                        {l.workBottleneck && (
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            <span className="font-bold">詰まった点:</span> {l.workBottleneck}
                          </p>
                        )}
                        {l.workLearnings && (
                          <p className="text-xs text-blue-700 dark:text-blue-300">
                            <span className="font-bold">知見:</span> {l.workLearnings}
                          </p>
                        )}
                        {l.workNextAction && (
                          <p className="text-xs text-emerald-700 dark:text-emerald-300">
                            <span className="font-bold">次への行動:</span> {l.workNextAction}
                          </p>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}