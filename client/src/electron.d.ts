import type * as React from "react";

declare global {
  interface Window {
    hDesktop?: {
      isDesktop: boolean;
      browserPreloadUrl?: string;
      openFolder?: () => Promise<string>;
      openFile?: () => Promise<string>;
      captureBrowserPage?: (webContentsId: number) => Promise<{ b64: string; width: number; height: number } | null>;
      sendBrowserInput?: (
        webContentsId: number,
        events: Array<{
          type: string;
          x?: number;
          y?: number;
          button?: string;
          clickCount?: number;
          keyCode?: string | number;
          modifiers?: string[];
          deltaX?: number;
          deltaY?: number;
          wheelTicksX?: number;
          wheelTicksY?: number;
        }>
      ) => Promise<boolean>;
      resolveElementAtPoint?: (
        webContentsId: number,
        x: number,
        y: number
      ) => Promise<{ label?: string; quads?: { left: number; top: number; right: number; bottom: number } } | null>;
      onBrowserOpenUrl?: (callback: (url: string) => void) => (() => void) | void;
      setSitePermissions?: (origin: string, permissions: Record<string, boolean>) => Promise<boolean>;
      openResourceMonitor?: () => void;
      closeResourceMonitor?: () => void;
      openSettings?: () => void;
      closeSettings?: () => void;
      minimize?: () => void;
      maximize?: () => void;
      close?: () => void;
      isMaximized?: () => Promise<boolean>;
      newWindow?: () => void;
      setTitle?: (title: string) => void;
    };
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        preload?: string;
        partition?: string;
        allowpopups?: boolean | "true" | "false";
      };
    }
  }
}

export {};
