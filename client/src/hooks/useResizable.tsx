import { useRef, useCallback, useState, useEffect } from "react";

interface DragState {
  startPos: number;
  startSize: number;
  axis: "x" | "y";
  invert: boolean;
}

/** invert=true for right-side panels (console) and bottom panels (terminal) */
export function useResizable(initialSize: number, minSize = 100, maxSize = Infinity, invert = false) {
  const [size, setSize] = useState(initialSize);
  const sizeRef = useRef(size);
  const dragRef = useRef<DragState | null>(null);
  const minRef = useRef(minSize);
  const maxRef = useRef(maxSize);
  const invertRef = useRef(invert);

  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { minRef.current = minSize; }, [minSize]);
  useEffect(() => { maxRef.current = maxSize; }, [maxSize]);
  useEffect(() => { invertRef.current = invert; }, [invert]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const axis = target.classList.contains("resize-handle-v") ? "y" : "x";
    dragRef.current = {
      startPos: axis === "y" ? e.clientY : e.clientX,
      startSize: sizeRef.current,
      axis,
      invert: invertRef.current,
    };
    document.documentElement.style.cursor = axis === "y" ? "row-resize" : "col-resize";
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const pos = dragRef.current.axis === "y" ? e.clientY : e.clientX;
      const delta = pos - dragRef.current.startPos;
      const effectiveDelta = dragRef.current.invert ? -delta : delta;
      const clamped = Math.min(maxRef.current, Math.max(minRef.current, dragRef.current.startSize + effectiveDelta));
      setSize(clamped);
      document.body.classList.add("resizing");
    };
    const onMouseUp = () => {
      dragRef.current = null;
      document.documentElement.style.cursor = "";
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.documentElement.style.cursor = "";
      document.body.classList.remove("resizing");
    };
  }, []);

  return { size, onMouseDown };
}

export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return <div className="resize-handle" onMouseDown={onMouseDown} />;
}
