export type ServerEvent =
  | { type: "task"; task: unknown }
  | { type: "log"; taskId: string; stream: "stdout" | "stderr"; line: string }
  | { type: "hello"; runtime: string };

type Listener = (event: ServerEvent) => void;

export class Bus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
