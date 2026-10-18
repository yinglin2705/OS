"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import AnnotationSurface from "./AnnotationSurface";
import type { HighlightColor } from "@/lib/board-interactions";
export default function PdfReader({
  url,
  page,
  onPage,
  eventId,
  cardId,
  active,
  color,
  onToggle,
  onError,
  disabled,
}: {
  url: string;
  page: number;
  onPage: (n: number) => void;
  eventId: string;
  cardId: string;
  active: boolean;
  color: HighlightColor;
  onToggle: () => void;
  onError: (s: string) => void;
  disabled: boolean;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState(""),
    [width, setWidth] = useState(480),
    [rendering, setRendering] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    let task: { destroy: () => Promise<void> } | undefined;
    setDoc(null);
    setError("");
    (async () => {
      const pdf = await import("pdfjs-dist");
      if (!live) return;
      pdf.GlobalWorkerOptions.workerSrc = `/pdfjs/${pdf.version}/pdf.worker.min.mjs`;
      const loading = pdf.getDocument({
        url,
        isEvalSupported: false,
        cMapUrl: `/pdfjs/${pdf.version}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `/pdfjs/${pdf.version}/standard_fonts/`,
        wasmUrl: `/pdfjs/${pdf.version}/wasm/`,
      });
      task = loading;
      const document = await loading.promise;
      if (!live) return;
      if (document.numPages > 10000) throw Error("PDF 页数超过看板预览上限。");
      setDoc(document);
    })().catch(() => {
      if (live) setError("PDF 预览失败或链接已过期，请刷新，或打开原文件。");
    });
    return () => {
      live = false;
      void task?.destroy().catch(() => {});
    };
  }, [url]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, Math.round(entries[0].contentRect.width))),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const visiblePage = Math.max(1, Math.min(page, doc?.numPages || page));
  useEffect(() => {
    let cancelled = false;
    let render: { promise: Promise<void>; cancel: () => void } | undefined;
    if (!doc || !canvas.current) return;
    setRendering(true);
    setError("");
    (async () => {
      const p = await doc.getPage(visiblePage);
      if (cancelled || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      const view = p.getViewport({ scale: width / base.width });
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8000000 / (view.width * view.height)),
      );
      const surface = canvas.current;
      const context = surface.getContext("2d");
      if (!context) throw Error();
      surface.width = Math.round(view.width * ratio);
      surface.height = Math.round(view.height * ratio);
      surface.style.aspectRatio = `${view.width}/${view.height}`;
      render = p.render({
        canvas: surface,
        canvasContext: context,
        viewport: view,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await render.promise;
    })()
      .catch((e) => {
        if (!cancelled && e?.name !== "RenderingCancelledException")
          setError("这一页暂时无法显示，请尝试翻页或打开原文件。");
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, visiblePage, width]);
  return (
    <div className="pdf-reader">
      <div className="pdf-pagination" data-no-connect>
        <button
          aria-label="PDF 上一页"
          disabled={disabled || !doc || visiblePage <= 1}
          onClick={() => onPage(visiblePage - 1)}
        >
          ‹
        </button>
        <span aria-live="polite">
          {doc ? `${visiblePage} / ${doc.numPages}` : "加载 PDF…"}
        </span>
        <button
          aria-label="PDF 下一页"
          disabled={disabled || !doc || visiblePage >= doc.numPages}
          onClick={() => onPage(visiblePage + 1)}
        >
          ›
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer">
          原文件 ↗
        </a>
      </div>
      {error && <p role="status">{error}</p>}
      <div ref={container} className="pdf-page-container">
        <AnnotationSurface
          key={`${cardId}:${visiblePage}`}
          eventId={eventId}
          cardId={cardId}
          page={visiblePage}
          active={active && !rendering && !!doc}
          color={color}
          onToggle={onToggle}
          onError={onError}
        >
          <canvas
            ref={canvas}
            className="pdf-page-canvas"
            aria-label={`PDF 第${visiblePage}页`}
          />
        </AnnotationSurface>
      </div>
    </div>
  );
}
