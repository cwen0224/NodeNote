export class CommandBus {
  constructor({ execute, onCommit } = {}) {
    this.executeImpl = execute || null;
    this.onCommit = onCommit || null;
    this.registry = new Map();
  }

  register(type, handler) {
    this.registry.set(type, handler);
  }

  execute(command) {
    if (!command || typeof command.type !== 'string') {
      throw new Error('CommandBus.execute requires a command with a type.');
    }

    const handler = this.registry.get(command.type) || this.executeImpl;
    if (!handler) {
      throw new Error(`No handler registered for command: ${command.type}`);
    }

    const result = handler(command);
    if (this.onCommit) {
      this.onCommit(command, result);
    }
    return result;
  }
}

