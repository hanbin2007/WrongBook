// Wrongbook Web App - 精简版
// 功能：错题版+干净版 PDF 配对、框选错题、间隔重复复习（本地 LocalStorage）

import React, { useState, useEffect, useRef, useMemo } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";

const STORAGE_KEYS = {
  documents: "wrongbook_documents_v1",
  mistakes: "wrongbook_mistakes_v1",
  reviews: "wrongbook_reviews_v1",
};

function createId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isDue(m) {
  if (!m.nextReviewAt) return true;
  return new Date(m.nextReviewAt).getTime() <= Date.now();
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function scheduleInitial(now) {
  return {
    lastReviewedAt: null,
    nextReviewAt: now.toISOString(),
    intervalDays: 0,
    easiness: 2.5,
    reviewStreak: 0,
  };
}

function applyReview(mistake, rating) {
  const now = new Date();
  let interval = mistake.intervalDays || 0;
  let ease = mistake.easiness || 2.5;
  let streak = mistake.reviewStreak || 0;
  const oldInterval = interval;

  switch (rating) {
    case "again":
      interval = 1;
      ease = Math.max(1.3, ease - 0.3);
      streak = 0;
      break;
    case "hard":
      interval = Math.max(1, Math.round(interval * 1.2) || 1);
      ease = Math.max(1.3, ease - 0.15);
      streak = 0;
      break;
    case "good":
      interval = interval === 0 ? 1 : Math.max(1, Math.round(interval * ease));
      streak += 1;
      break;
    case "easy":
      interval = interval === 0 ? 2 : Math.max(2, Math.round(interval * (ease + 0.15)));
      ease += 0.1;
      streak += 1;
      break;
    default:
      break;
  }

  const next = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

  return {
    updated: {
      ...mistake,
      intervalDays: interval,
      easiness: ease,
      reviewStreak: streak,
      lastReviewedAt: now.toISOString(),
      nextReviewAt: next.toISOString(),
    },
    log: {
      id: createId(),
      mistakeId: mistake.id,
      rating,
      reviewedAt: now.toISOString(),
      oldInterval,
      newInterval: interval,
    },
  };
}

function loadFromStorage(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveToStorage(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function App() {
  const [documentMetas, setDocumentMetas] = useState([]);
  const [mistakes, setMistakes] = useState([]);
  const [reviewLogs, setReviewLogs] = useState([]);
  const [loadedDocs, setLoadedDocs] = useState([]);
  const [view, setView] = useState("workspace"); // workspace | review | dashboard
  const [selectedPairId, setSelectedPairId] = useState("");
  const [selectedRole, setSelectedRole] = useState("with_handwriting");
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [reviewIndex, setReviewIndex] = useState(0);

  // init
  useEffect(() => {
    setDocumentMetas(loadFromStorage(STORAGE_KEYS.documents, []));
    setMistakes(loadFromStorage(STORAGE_KEYS.mistakes, []));
    setReviewLogs(loadFromStorage(STORAGE_KEYS.reviews, []));
  }, []);

  useEffect(() => saveToStorage(STORAGE_KEYS.documents, documentMetas), [documentMetas]);
  useEffect(() => saveToStorage(STORAGE_KEYS.mistakes, mistakes), [mistakes]);
  useEffect(() => saveToStorage(STORAGE_KEYS.reviews, reviewLogs), [reviewLogs]);

  const pairs = useMemo(() => {
    const map = new Map();
    documentMetas.forEach((doc) => {
      if (!map.has(doc.pairGroupId)) {
        map.set(doc.pairGroupId, {
          pairGroupId: doc.pairGroupId,
          title: doc.title,
          hasWith: doc.role === "with_handwriting",
          hasClean: doc.role === "clean",
        });
      } else {
        const ex = map.get(doc.pairGroupId);
        map.set(doc.pairGroupId, {
          pairGroupId: doc.pairGroupId,
          title: ex.title || doc.title,
          hasWith: ex.hasWith || doc.role === "with_handwriting",
          hasClean: ex.hasClean || doc.role === "clean",
        });
      }
    });
    return Array.from(map.values());
  }, [documentMetas]);

  const currentPair = useMemo(
    () => pairs.find((p) => p.pairGroupId === selectedPairId) || null,
    [pairs, selectedPairId]
  );

  const currentWithMeta = useMemo(() => {
    if (!currentPair) return null;
    return (
      documentMetas.find(
        (d) => d.pairGroupId === currentPair.pairGroupId && d.role === "with_handwriting"
      ) || null
    );
  }, [documentMetas, currentPair]);

  const currentCleanMeta = useMemo(() => {
    if (!currentPair) return null;
    return (
      documentMetas.find(
        (d) => d.pairGroupId === currentPair.pairGroupId && d.role === "clean"
      ) || null
    );
  }, [documentMetas, currentPair]);

  const getLoadedDoc = (fingerprint, role) =>
    loadedDocs.find((d) => d.fingerprint === fingerprint && d.role === role) || null;

  // 上传错题版
  const handleUploadWithHandwriting = async (file) => {
    if (!file) return;
    try {
      if (!crypto?.subtle?.digest) {
        alert("当前环境不支持 crypto.subtle，请在 localhost 或 https 下运行。");
        return;
      }
      const title = file.name.replace(/\.pdf$/i, "");
      const fingerprint = await hashFile(file);
      const url = URL.createObjectURL(file);
      const pdf = await getDocument(url).promise;
      const pageCount = pdf.numPages;
      pdf.destroy();

      let meta = documentMetas.find(
        (d) => d.fingerprint === fingerprint && d.role === "with_handwriting"
      );
      let pairGroupId;

      if (!meta) {
        pairGroupId = createId();
        meta = { fingerprint, title, pageCount, pairGroupId, role: "with_handwriting" };
        setDocumentMetas((prev) => [...prev, meta]);
      } else {
        pairGroupId = meta.pairGroupId;
        setDocumentMetas((prev) =>
          prev.map((d) =>
            d.fingerprint === fingerprint && d.role === "with_handwriting"
              ? { ...d, title, pageCount }
              : d
          )
        );
      }

      setLoadedDocs((prev) => [
        ...prev.filter(
          (d) => !(d.fingerprint === fingerprint && d.role === "with_handwriting")
        ),
        { fingerprint, role: "with_handwriting", file, url, pageCount },
      ]);

      setSelectedPairId(pairGroupId);
      setSelectedRole("with_handwriting");
      setSelectedPageIndex(0);
    } catch (e) {
      console.error(e);
      alert("上传错题版 PDF 时出错：" + (e?.message || e));
    }
  };

  // 上传干净版（与当前错题版配对）
  const handleUploadClean = async (file) => {
    if (!file || !currentWithMeta) return;
    try {
      if (!crypto?.subtle?.digest) {
        alert("当前环境不支持 crypto.subtle，请在 localhost 或 https 下运行。");
        return;
      }
      const fingerprint = await hashFile(file);
      const title = currentWithMeta.title + "（干净版）";
      const url = URL.createObjectURL(file);
      const pdf = await getDocument(url).promise;
      const pageCount = pdf.numPages;
      pdf.destroy();

      if (pageCount !== currentWithMeta.pageCount) {
        alert("干净版 PDF 页数与错题版不一致，无法绑定。");
        URL.revokeObjectURL(url);
        return;
      }

      let meta = documentMetas.find(
        (d) => d.fingerprint === fingerprint && d.role === "clean"
      );

      if (!meta) {
        meta = {
          fingerprint,
          title,
          pageCount,
          pairGroupId: currentWithMeta.pairGroupId,
          role: "clean",
        };
        setDocumentMetas((prev) => [...prev, meta]);
      } else {
        setDocumentMetas((prev) =>
          prev.map((d) =>
            d.fingerprint === fingerprint && d.role === "clean"
              ? { ...d, title, pageCount, pairGroupId: currentWithMeta.pairGroupId }
              : d
          )
        );
      }

      setLoadedDocs((prev) => [
        ...prev.filter((d) => !(d.fingerprint === fingerprint && d.role === "clean")),
        { fingerprint, role: "clean", file, url, pageCount },
      ]);
    } catch (e) {
      console.error(e);
      alert("上传干净版 PDF 时出错：" + (e?.message || e));
    }
  };

  const handleCreateMistake = (bbox) => {
    if (!currentWithMeta) return;
    const cleanMeta = currentCleanMeta || null;
    const now = new Date();
    const sched = scheduleInitial(now);
    const m = {
      id: createId(),
      pairGroupId: currentWithMeta.pairGroupId,
      originalFingerprint: currentWithMeta.fingerprint,
      cleanFingerprint: cleanMeta ? cleanMeta.fingerprint : null,
      pageIndex: selectedPageIndex,
      bbox,
      title: "",
      note: "",
      tags: [],
      createdAt: now.toISOString(),
      lastReviewedAt: sched.lastReviewedAt,
      nextReviewAt: sched.nextReviewAt,
      intervalDays: sched.intervalDays,
      easiness: sched.easiness,
      reviewStreak: sched.reviewStreak,
    };
    setMistakes((prev) => [...prev, m]);
  };

  const handleUpdateMistakeMeta = (id, patch) => {
    setMistakes((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const handleDeleteMistake = (id) => {
    if (!window.confirm("确定要删除这条错题吗？")) return;
    setMistakes((prev) => prev.filter((m) => m.id !== id));
    setReviewLogs((prev) => prev.filter((r) => r.mistakeId !== id));
  };

  const currentPairMistakes = useMemo(() => {
    if (!currentPair) return [];
    return mistakes.filter((m) => m.pairGroupId === currentPair.pairGroupId);
  }, [mistakes, currentPair]);

  const dueMistakes = useMemo(() => mistakes.filter(isDue), [mistakes]);

  useEffect(() => setReviewIndex(0), [dueMistakes.length]);

  const currentReviewMistake = dueMistakes[reviewIndex] || null;

  const handleReview = (rating) => {
    if (!currentReviewMistake) return;
    const { updated, log } = applyReview(currentReviewMistake, rating);
    setMistakes((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    setReviewLogs((prev) => [...prev, log]);
    setReviewIndex((i) => ((i + 1) < dueMistakes.length ? i + 1 : 0));
  };

  const totalMistakeCount = mistakes.length;
  const dueCount = dueMistakes.length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayDoneCount = reviewLogs.filter(
    (log) => (log.reviewedAt || "").slice(0, 10) === todayStr
  ).length;

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-50 flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">Wrongbook · Web</span>
          <span className="text-xs text-slate-400">PDF 错题本 + 间隔复习</span>
        </div>
        <nav className="flex gap-2 text-sm">
          <NavButton active={view === "workspace"} onClick={() => setView("workspace")}>
            错题管理
          </NavButton>
          <NavButton active={view === "review"} onClick={() => setView("review")}>
            今日复习
          </NavButton>
          <NavButton active={view === "dashboard"} onClick={() => setView("dashboard")}>
            仪表盘
          </NavButton>
        </nav>
      </header>

      <div className="flex-1 flex min-h-0">
        {view === "workspace" && (
          <WorkspaceView
            pairs={pairs}
            documentMetas={documentMetas}
            loadedDocs={loadedDocs}
            onUploadWithHandwriting={handleUploadWithHandwriting}
            onUploadClean={handleUploadClean}
            selectedPairId={selectedPairId}
            setSelectedPairId={setSelectedPairId}
            selectedRole={selectedRole}
            setSelectedRole={setSelectedRole}
            selectedPageIndex={selectedPageIndex}
            setSelectedPageIndex={setSelectedPageIndex}
            currentWithMeta={currentWithMeta}
            currentCleanMeta={currentCleanMeta}
            currentPairMistakes={currentPairMistakes}
            onCreateMistake={handleCreateMistake}
            onUpdateMistakeMeta={handleUpdateMistakeMeta}
            onDeleteMistake={handleDeleteMistake}
            getLoadedDoc={getLoadedDoc}
          />
        )}
        {view === "review" && (
          <ReviewView
            current={currentReviewMistake}
            index={reviewIndex}
            total={dueMistakes.length}
            onReview={handleReview}
            documentMetas={documentMetas}
            getLoadedDoc={getLoadedDoc}
          />
        )}
        {view === "dashboard" && (
          <DashboardView
            totalMistakeCount={totalMistakeCount}
            dueCount={dueCount}
            todayDoneCount={todayDoneCount}
          />
        )}
      </div>
    </div>
  );
}

function NavButton({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium border ${
        active
          ? "bg-sky-500 text-white border-sky-400"
          : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function WorkspaceView(props) {
  const {
    pairs,
    documentMetas,
    loadedDocs,
    onUploadWithHandwriting,
    onUploadClean,
    selectedPairId,
    setSelectedPairId,
    selectedRole,
    setSelectedRole,
    selectedPageIndex,
    setSelectedPageIndex,
    currentWithMeta,
    currentCleanMeta,
    currentPairMistakes,
    onCreateMistake,
    onUpdateMistakeMeta,
    onDeleteMistake,
    getLoadedDoc,
  } = props;

  const handleWithFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadWithHandwriting(file);
      e.target.value = "";
    }
  };

  const handleCleanFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadClean(file);
      e.target.value = "";
    }
  };

  const selectedMeta =
    selectedRole === "with_handwriting" ? currentWithMeta : currentCleanMeta;
  const loadedDoc =
    selectedMeta && getLoadedDoc(selectedMeta.fingerprint, selectedMeta.role);
  const pageCount = selectedMeta?.pageCount || 0;

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="w-72 border-r border-slate-800 bg-slate-900/60 p-3 flex flex-col gap-3">
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-1">上传错题版 PDF</div>
          <input
            type="file"
            accept="application/pdf"
            onChange={handleWithFileChange}
            className="block w-full text-xs text-slate-300 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-sky-600 file:text-xs file:text-white hover:file:bg-sky-500"
          />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
            <span>文档配对</span>
            <span className="text-[10px] text-slate-500">先选错题版，再补充干净版</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-auto pr-1">
            {pairs.length === 0 && (
              <div className="text-xs text-slate-500">先上传一份错题版 PDF。</div>
            )}
            {pairs.map((p) => {
              const withMeta = documentMetas.find(
                (d) => d.pairGroupId === p.pairGroupId && d.role === "with_handwriting"
              );
              const pairMistakeCount = (props.mistakes || []).filter(
                (m) => m.pairGroupId === p.pairGroupId
              ).length;
              return (
                <button
                  key={p.pairGroupId}
                  onClick={() => {
                    setSelectedPairId(p.pairGroupId);
                    setSelectedRole("with_handwriting");
                    setSelectedPageIndex(0);
                  }}
                  className={`w-full text-left px-2 py-1 rounded border text-xs flex flex-col gap-0.5 ${
                    selectedPairId === p.pairGroupId
                      ? "border-sky-500 bg-sky-500/10"
                      : "border-slate-700 hover:border-slate-500"
                  }`}
                >
                  <span className="font-medium text-slate-100 truncate">
                    {withMeta?.title || p.title || "未命名文档"}
                  </span>
                  <span className="text-[10px] text-slate-400 flex justify-between">
                    <span>
                      {p.hasWith ? "错题版✓" : "错题版✗"} · {p.hasClean ? "干净版✓" : "干净版✗"}
                    </span>
                    <span>错题 {pairMistakeCount}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {currentWithMeta && (
          <div>
            <div className="text-xs font-semibold text-slate-300 mb-1">
              当前配对：{currentWithMeta.title}
            </div>
            <input
              type="file"
              accept="application/pdf"
              onChange={handleCleanFileChange}
              className="block w-full text-xs text-slate-300 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-emerald-600 file:text-xs file:text-white hover:file:bg-emerald-500"
            />
          </div>
        )}
      </aside>

      <main className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">当前视图：</span>
              <button
                className={`px-2 py-0.5 rounded-full border ${
                  selectedRole === "with_handwriting"
                    ? "bg-sky-600 border-sky-400 text-white"
                    : "border-slate-700 text-slate-300 hover:border-slate-500"
                }`}
                onClick={() => setSelectedRole("with_handwriting")}
              >
                错题版
              </button>
              <button
                className={`px-2 py-0.5 rounded-full border ${
                  selectedRole === "clean"
                    ? "bg-emerald-600 border-emerald-400 text-white"
                    : "border-slate-700 text-slate-300 hover:border-slate-500"
                }`}
                onClick={() => setSelectedRole("clean")}
                disabled={!currentCleanMeta}
              >
                干净版
              </button>
            </div>
            <div className="flex items-center gap-2 text-slate-400">
              <span>页码：</span>
              <input
                type="number"
                min={1}
                max={pageCount || 1}
                value={pageCount ? selectedPageIndex + 1 : 1}
                onChange={(e) => {
                  const n = parseInt(e.target.value || "1", 10);
                  if (!Number.isNaN(n) && n >= 1 && n <= (pageCount || 1)) {
                    setSelectedPageIndex(n - 1);
                  }
                }}
                className="w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-100"
              />
              <span>/ {pageCount || 0}</span>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-center bg-slate-950 min-h-0">
            {!selectedMeta && (
              <div className="text-xs text-slate-500">
                请先在左侧上传错题版 PDF，并选择一套卷子。
              </div>
            )}
            {selectedMeta && !loadedDoc && (
              <div className="text-xs text-slate-500">
                当前 PDF 尚未加载，请在左侧重新上传对应版本。
              </div>
            )}
            {selectedMeta && loadedDoc && (
              <PdfPageViewer
                key={loadedDoc.url + "-" + selectedPageIndex}
                fileUrl={loadedDoc.url}
                pageIndex={selectedPageIndex}
                interactive={selectedRole === "with_handwriting"}
                onRectSelected={onCreateMistake}
                highlightRects={currentPairMistakes
                  .filter((m) => m.pageIndex === selectedPageIndex)
                  .map((m) => m.bbox)}
              />
            )}
          </div>
        </div>

        <aside className="w-80 border-l border-slate-800 bg-slate-900/60 p-3 flex flex-col min-h-0">
          <div className="text-xs font-semibold text-slate-200 mb-2">
            本套卷错题（{currentPairMistakes.length}）
          </div>
          <div className="flex-1 overflow-auto space-y-2 pr-1">
            {currentPairMistakes.length === 0 && (
              <div className="text-xs text-slate-500">
                在 PDF 上拖拽框选错题区域即可创建错题卡。
              </div>
            )}
            {currentPairMistakes
              .slice()
              .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
              .map((m) => (
                <MistakeCard
                  key={m.id}
                  mistake={m}
                  onUpdate={handleUpdateMistakeMeta}
                  onDelete={onDeleteMistake}
                  onJump={() => {
                    setSelectedPairId(m.pairGroupId);
                    setSelectedRole("with_handwriting");
                    setSelectedPageIndex(m.pageIndex);
                  }}
                />
              ))}
          </div>
        </aside>
      </main>
    </div>
  );
}

function MistakeCard({ mistake, onUpdate, onDelete, onJump }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingNote, setEditingNote] = useState(false);

  return (
    <div className="border border-slate-800 rounded-lg p-2 bg-slate-900/80 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onJump}
          className="text-xs font-semibold text-sky-300 hover:text-sky-100"
        >
          第 {mistake.pageIndex + 1} 页 · 错题
        </button>
        <button
          onClick={() => onDelete(mistake.id)}
          className="text-[10px] text-red-400 hover:text-red-200"
        >
          删除
        </button>
      </div>
      <div>
        {editingTitle ? (
          <input
            autoFocus
            defaultValue={mistake.title}
            onBlur={(e) => {
              onUpdate(mistake.id, { title: e.target.value });
              setEditingTitle(false);
            }}
            className="w-full bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-100"
          />
        ) : (
          <button
            className="w-full text-left text-xs text-slate-200 break-words"
            onClick={() => setEditingTitle(true)}
          >
            {mistake.title || <span className="text-slate-500">点击添加简要描述</span>}
          </button>
        )}
      </div>
      <div>
        <div className="text-[10px] text-slate-500 mb-0.5">反思 / 解析：</div>
        {editingNote ? (
          <textarea
            autoFocus
            defaultValue={mistake.note}
            rows={3}
            onBlur={(e) => {
              onUpdate(mistake.id, { note: e.target.value });
              setEditingNote(false);
            }}
            className="w-full bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-100 resize-none"
          />
        ) : (
          <button
            className="w-full text-left text-[11px] text-slate-300 whitespace-pre-wrap break-words min-h-[1.5em]"
            onClick={() => setEditingNote(true)}
          >
            {mistake.note || (
              <span className="text-slate-500">点击填写错误原因、正确解法要点</span>
            )}
          </button>
        )}
      </div>
      <div className="text-[10px] text-slate-500 flex justify-between">
        <span>下次复习：{mistake.nextReviewAt.slice(0, 10)}</span>
        <span>间隔：{mistake.intervalDays} 天</span>
      </div>
    </div>
  );
}

function ReviewView({ current, index, total, onReview, documentMetas, getLoadedDoc }) {
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => setShowOriginal(false), [current?.id]);

  if (!current || total === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950">
        <div className="text-xs text-slate-500">
          暂无需要复习的错题。先在“错题管理”创建一些错题卡。
        </div>
      </div>
    );
  }

  const cleanMeta =
    current.cleanFingerprint &&
    documentMetas.find(
      (d) => d.fingerprint === current.cleanFingerprint && d.role === "clean"
    );
  const withMeta = documentMetas.find(
    (d) => d.fingerprint === current.originalFingerprint && d.role === "with_handwriting"
  );

  const preferClean = cleanMeta && !showOriginal;
  const activeMeta = preferClean ? cleanMeta : withMeta;
  const loadedDoc =
    activeMeta && getLoadedDoc(activeMeta.fingerprint, activeMeta.role);

  return (
    <div className="flex-1 flex flex-col bg-slate-950">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/70 text-xs">
        <div className="text-slate-300">
          今日复习进度：{index + 1} / {total}
        </div>
        <div className="flex items-center gap-2 text-slate-400">
          <span>显示：</span>
          <button
            className={`px-2 py-0.5 rounded-full border ${
              !showOriginal
                ? "bg-emerald-600 border-emerald-400 text-white"
                : "border-slate-700 text-slate-300 hover:border-slate-500"
            }`}
            onClick={() => setShowOriginal(false)}
            disabled={!cleanMeta}
          >
            干净版
          </button>
          <button
            className={`px-2 py-0.5 rounded-full border ${
              showOriginal
                ? "bg-sky-600 border-sky-400 text-white"
                : "border-slate-700 text-slate-300 hover:border-slate-500"
            }`}
            onClick={() => setShowOriginal(true)}
            disabled={!withMeta}
          >
            原稿
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex items-center justify-center">
          {!activeMeta && (
            <div className="text-xs text-slate-500">
              当前错题关联的 PDF 未加载，请在“错题管理”中上传对应文档。
            </div>
          )}
          {activeMeta && !loadedDoc && (
            <div className="text-xs text-slate-500">
              {activeMeta.role === "clean"
                ? "干净版 PDF 未加载。"
                : "错题版 PDF 未加载。"}
            </div>
          )}
          {activeMeta && loadedDoc && (
            <PdfPageViewer
              fileUrl={loadedDoc.url}
              pageIndex={current.pageIndex}
              interactive={false}
              highlightRects={[current.bbox]}
            />
          )}
        </div>

        <aside className="w-80 border-l border-slate-800 bg-slate-900/70 p-3 flex flex-col gap-2">
          <div className="text-xs font-semibold text-slate-200">回忆 & 反思</div>
          <div className="text-xs text-slate-100 whitespace-pre-wrap bg-slate-950/70 border border-slate-800 rounded p-2 min-h-[64px]">
            {current.title || <span className="text-slate-500">在错题管理中给这道题加一个标题。</span>}
          </div>
          <div className="text-[11px] text-slate-300 whitespace-pre-wrap bg-slate-950/70 border border-slate-800 rounded p-2 min-h-[80px]">
            {current.note || (
              <span className="text-slate-500">
                解析 / 反思：错误原因、正确解法、易混点（在错题管理中填写）。
              </span>
            )}
          </div>

          <div className="mt-auto">
            <div className="text-[11px] text-slate-400 mb-1">记忆情况：</div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <button
                onClick={() => onReview("again")}
                className="px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 text-xs text-white"
              >
                完全忘
              </button>
              <button
                onClick={() => onReview("hard")}
                className="px-2 py-1 rounded bg-orange-600/80 hover:bg-orange-600 text-xs text-white"
              >
                模糊
              </button>
              <button
                onClick={() => onReview("good")}
                className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-xs text-white"
              >
                基本记
              </button>
              <button
                onClick={() => onReview("easy")}
                className="px-2 py-1 rounded bg-sky-600/80 hover:bg-sky-600 text-xs text-white"
              >
                很熟
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function DashboardView({ totalMistakeCount, dueCount, todayDoneCount }) {
  return (
    <div className="flex-1 flex flex-col bg-slate-950 p-4 gap-4 text-xs text-slate-200">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="总错题数量" value={totalMistakeCount} />
        <StatCard label="当前待复习" value={dueCount} />
        <StatCard label="今日已复习" value={todayDoneCount} />
      </div>
      <div className="text-[10px] text-slate-500">
        仪表盘精简版：后续可以在这里加折线图、热力图等可视化。
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900/70 p-3 flex flex-col gap-1">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-slate-50">{value}</div>
    </div>
  );
}

function PdfPageViewer({ fileUrl, pageIndex, interactive, onRectSelected, highlightRects }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState(null);
  const startRef = useRef(null);

  useEffect(() => {
    let canceled = false;
    async function render() {
      if (!fileUrl || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const pdf = await getDocument(fileUrl).promise;
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.5 });
      if (canceled) {
        pdf.destroy();
        return;
      }

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (!canceled) setRenderSize({ width: viewport.width, height: viewport.height });
      pdf.destroy();
    }
    render();
    return () => {
      canceled = true;
    };
  }, [fileUrl, pageIndex]);

  const handleMouseDown = (e) => {
    if (!interactive || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    startRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setSelection({ x: startRef.current.x, y: startRef.current.y, width: 0, height: 0 });
  };

  const handleMouseMove = (e) => {
    if (!interactive || !overlayRef.current || !startRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sx = startRef.current.x;
    const sy = startRef.current.y;
    const w = x - sx;
    const h = y - sy;
    setSelection({
      x: w >= 0 ? sx : sx + w,
      y: h >= 0 ? sy : sy + h,
      width: Math.abs(w),
      height: Math.abs(h),
    });
  };

  const handleMouseUp = () => {
    if (!interactive || !overlayRef.current || !selection) {
      startRef.current = null;
      setSelection(null);
      return;
    }
    const rect = overlayRef.current.getBoundingClientRect();
    const minSize = 10;
    if (selection.width >= minSize && selection.height >= minSize) {
      const bbox = {
        x: selection.x / rect.width,
        y: selection.y / rect.height,
        width: selection.width / rect.width,
        height: selection.height / rect.height,
      };
      onRectSelected && onRectSelected(bbox);
    }
    startRef.current = null;
    setSelection(null);
  };

  return (
    <div className="relative bg-slate-900 rounded-lg border border-slate-800 overflow-auto max-h-full max-w-full">
      <div className="relative inline-block">
        <canvas ref={canvasRef} className="block bg-slate-950" />
        <div
          ref={overlayRef}
          className="absolute inset-0 cursor-crosshair"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {selection && (
            <div
              className="absolute border border-sky-400/80 bg-sky-500/10"
              style={{
                left: selection.x,
                top: selection.y,
                width: selection.width,
                height: selection.height,
              }}
            />
          )}
          {highlightRects &&
            renderSize.width > 0 &&
            highlightRects.map((r, i) => (
              <div
                key={i}
                className="absolute border border-amber-400/80 bg-amber-300/10"
                style={{
                  left: r.x * renderSize.width,
                  top: r.y * renderSize.height,
                  width: r.width * renderSize.width,
                  height: r.height * renderSize.height,
                }}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
