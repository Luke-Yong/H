import type * as React from "react";

declare global {
  interface Window {
    harnessDesktop?: {
      isDesktop: boolean;
      browserPreloadUrl?: string;
      openFolder?: () => Promise<string>;
      openFile?: () => Promise<string>;
      onBrowserOpenUrl?: (callback: (url: string) => void) => (() => void) | void;
      setSitePermissions?: (origin: string, permissions: Record<string, boolean>) => Promise<boolean>;
      openResourceMonitor?: () => void;
      closeResourceMonitor?: () => void;
      minimize?: () => void;
      maximize?: () => void;
      close?: () => void;
      isMaximized?: () => Promise<boolean>;
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
