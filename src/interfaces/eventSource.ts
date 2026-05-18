export type Unsubscribe = () => void;

export interface IEventSource<T> {
    subscribe(handler: (value: T) => void): Unsubscribe;
}

export interface IEventEmitter<T> extends IEventSource<T> {
    emit(value: T): void;
    clear(): void;
}

export function createEventEmitter<T>(): IEventEmitter<T> {
    const handlers = new Set<(value: T) => void>();

    return {
        subscribe(handler) {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },

        emit(value) {
            // copie implicite via iteration Set, evite des surprises si un handler unsubscribe pendant emit
            for (const h of handlers) h(value);
        },

        clear() {
            handlers.clear();
        },
    };
}
