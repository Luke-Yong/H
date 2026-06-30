// ── Shared bridge between AgentConsole and TerminalPane ──
// When the agent runs a non-sandbox command, the agent console sets a
// pending command here. TerminalPane creates a real terminal instance,
// runs the command, and streams output back. Both the xterm viewport and
// the agent console's terminal block show the same output.

export interface AgentTerminalCommand {
  id: string;        // tool call ID from the agent
  command: string;   // shell command to run
}

export interface AgentTerminalBridge {
  /** Set a command for the terminal pane to execute. */
  setCommand: (cmd: AgentTerminalCommand) => void;
  /** Subscribe to terminal output. Returns unsubscribe fn. */
  onOutput: (handler: (text: string) => void) => () => void;
  /** Subscribe to terminal finish (exit). Returns unsubscribe fn. */
  onFinish: (handler: (exitCode: number | null) => void) => () => void;
}

/** Internal interface used by TerminalPane to push data into the bridge. */
export interface AgentTerminalBridgeInternal extends AgentTerminalBridge {
  _consumeCommand: () => AgentTerminalCommand | null;
  _pushOutput: (text: string) => void;
  _pushFinish: (exitCode: number | null) => void;
}

export function createAgentTerminalBridge(): AgentTerminalBridgeInternal {
  let activeCommand: AgentTerminalCommand | null = null;
  const outputHandlers = new Set<(text: string) => void>();
  const finishHandlers = new Set<(exitCode: number | null) => void>();

  return {
    setCommand(cmd: AgentTerminalCommand) {
      activeCommand = cmd;
    },

    _consumeCommand(): AgentTerminalCommand | null {
      const cmd = activeCommand;
      activeCommand = null;
      return cmd;
    },

    _pushOutput(text: string) {
      for (const h of outputHandlers) h(text);
    },

    _pushFinish(exitCode: number | null) {
      for (const h of finishHandlers) h(exitCode);
    },

    onOutput(handler: (text: string) => void) {
      outputHandlers.add(handler);
      return () => { outputHandlers.delete(handler); };
    },

    onFinish(handler: (exitCode: number | null) => void) {
      finishHandlers.add(handler);
      return () => { finishHandlers.delete(handler); };
    },
  };
}
