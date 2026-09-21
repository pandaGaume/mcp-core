import type { IMessageTransport, IMcpBehavior, IMcpInitializer, IMcpServer, IMcpServerBuilder, IMcpServerHandlers, IMcpServerOptions, McpGrammarResolver } from "../interfaces";
import { McpGrammar } from "../mcp.grammar";
import type { McpGrammarStore } from "../mcp.grammarStore";
import type { GrammarResolverOptions } from "../mcp.resolver";
import { grammarResolverFromOptions } from "../mcp.resolver";
import { McpServer } from "./mcp.server";

/**
 * Fluent builder that constructs a configured {@link McpServer}.
 *
 * @example
 * ```typescript
 * const server = new McpServerBuilder()
 *     .withName("my-app")
 *     .withTransport(new StdioTransport())
 *     .withInitializer(new SceneInitializer())
 *     .withGrammar("concise", McpGrammar.fromJSON(conciseData))
 *     .withGrammar("verbose", McpGrammar.fromJSON(verboseData))
 *     .withGrammarResolver(client => client.name.includes("claude") ? "concise" : "verbose")
 *     .register(new MeshBehavior(), new LightBehavior())
 *     .withOptions({ idleTimeoutMs: 30_000 })
 *     .build();
 *
 * await server.start();
 * ```
 */
export class McpServerBuilder implements IMcpServerBuilder {
    private _name = "mcp-server";
    private _initializer: IMcpInitializer | undefined;
    private _handlers: IMcpServerHandlers | undefined;
    private _behaviors: IMcpBehavior[] = [];
    private _options: IMcpServerOptions = {};
    private _grammars = new Map<string, McpGrammar>();
    private _wordingRule: string | undefined;
    private _grammarResolver: McpGrammarResolver | undefined;
    private _grammarStore: McpGrammarStore | undefined;
    private _transport: IMessageTransport | undefined;

    /** Sets the human-readable name reported in `initialize` responses. */
    withName(name: string): this {
        this._name = name;
        return this;
    }

    /**
     * Provides the domain-level initializer that supplies server identity and
     * protocol version during the MCP handshake.
     * If omitted, the server uses built-in defaults.
     */
    withInitializer(initializer: IMcpInitializer): this {
        this._initializer = initializer;
        return this;
    }

    /**
     * Registers one or more behavior types.
     * Accepts multiple behaviors in a single call for convenience.
     * Behaviors contribute to the advertised capabilities and enable {@link IMcpServer.attach}.
     */
    register(...behavior: IMcpBehavior[]): this {
        this._behaviors.push(...(behavior as IMcpBehavior[]));
        return this;
    }

    /**
     * Replaces the default JSON-RPC message routing with a custom handler implementation.
     * When omitted, {@link McpServer} handles routing itself using its built-in logic.
     *
     * Use this to intercept specific MCP methods, add logging, or delegate to a
     * completely different routing strategy.
     */
    withHandlers(handlers: IMcpServerHandlers): this {
        this._handlers = handlers;
        return this;
    }

    /**
     * Merges the given options with any previously set options.
     * Later calls override earlier ones for the same key.
     */
    withOptions(o: IMcpServerOptions): this {
        this._options = { ...this._options, ...o };
        return this;
    }

    /**
     * Registers a named grammar that can be selected per session based on
     * the connecting client. Use {@link withGrammarResolver} to map clients
     * to grammar keys.
     */
    withGrammar(key: string, grammar: McpGrammar): this {
        this._grammars.set(key, grammar);
        return this;
    }

    /** Registers several named grammars at once (a loaded directory, for one). */
    withGrammars(grammars: Iterable<readonly [string, McpGrammar]>): this {
        for (const [key, grammar] of grammars) this._grammars.set(key, grammar);
        return this;
    }

    /**
     * The wording rule, checked at {@link build}: every tool and every
     * resource of every behavior has a description, and has it in one place
     * only: inline in the behavior, or in the named grammar (the wording a
     * session falls back to), never both, never neither. The behavior's code
     * then declares structure and the grammar files carry the words, and a
     * text cannot drift between two copies.
     */
    withWordingRule(baselineKey: string): this {
        this._wordingRule = baselineKey;
        return this;
    }

    /**
     * Sets the policy that maps a connecting client to a grammar key, in
     * one of two forms:
     *
     *   - **Custom function** ({@link McpGrammarResolver}): arbitrary logic
     *     called during the `initialize` handshake with the client's
     *     identity and negotiated capabilities. May return a single key,
     *     a chain of candidate keys (most-specific first), or `undefined`.
     *
     *   - **Declarative options** ({@link GrammarResolverOptions}): the
     *     built-in helper composes an `<agent>:<locale>` chain (plus an
     *     optional `@version` suffix) with progressive narrowing. The
     *     application supplies a `localeSource` and optionally a
     *     `versionFrom`; everything else has sensible defaults.
     *
     * @example custom function
     * ```typescript
     * builder.withGrammarResolver((client) => `${client.name}:en`);
     * ```
     *
     * @example declarative options
     * ```typescript
     * builder.withGrammarResolver({
     *     localeSource: (_, caps) => caps?.locale,
     *     versionFrom:  (_, caps) => caps?.protocolVersion,
     * });
     * ```
     */
    withGrammarResolver(arg: McpGrammarResolver | GrammarResolverOptions): this {
        this._grammarResolver = typeof arg === "function" ? arg : grammarResolverFromOptions(arg);
        return this;
    }

    /**
     * Provides a shared grammar store for runtime grammar mutations.
     *
     * When set, the server merges store grammars with static grammars registered
     * via {@link withGrammar} (store grammars take priority). The server also
     * subscribes to store change events so it can re-merge the session grammar
     * and emit `notifications/tools/list_changed` when a profile is updated.
     */
    withGrammarStore(store: McpGrammarStore): this {
        this._grammarStore = store;
        return this;
    }

    /**
     * Sets the transport the server speaks through. Required.
     *
     * The server owns the protocol, never the connection: opening, framing and
     * reconnecting are the transport's business.
     *
     * @example
     * ```typescript
     * import { StdioTransport } from "@cyanmycelium/mcp-core/node";
     *
     * const server = new McpServerBuilder()
     *     .withName("scene")
     *     .withTransport(new StdioTransport())
     *     .build();
     * ```
     */
    withTransport(transport: IMessageTransport): this {
        this._transport = transport;
        return this;
    }

    /**
     * Constructs and returns a configured {@link IMcpServer}.
     * @throws {Error} if `withTransport()` was not called.
     */
    build(): IMcpServer {
        if (!this._transport) throw new Error("McpServerBuilder: withTransport() is required before build()");
        if (this._wordingRule !== undefined) {
            const problems = this._checkWording(this._wordingRule);
            if (problems.length) throw new Error(`McpServerBuilder: wording rule (${this._wordingRule}): ${problems.join("; ")}`);
        }

        const server = new McpServer(this._name, this._options, this._initializer, this._handlers, this._grammars, this._grammarResolver, this._transport, this._grammarStore);

        for (const behavior of this._behaviors) {
            server.register(behavior);
        }

        return server;
    }

    /** The problems the wording rule finds, readable, empty when the rule holds. */
    private _checkWording(baselineKey: string): string[] {
        const problems: string[] = [];
        const layers: McpGrammar[] = [];
        for (const behavior of this._behaviors) {
            const own = behavior.getGrammar?.(baselineKey);
            if (own) layers.push(own);
        }
        const static_ = this._grammars.get(baselineKey);
        if (static_) layers.push(static_);
        const store = this._grammarStore?.get(baselineKey);
        if (store) layers.push(store);
        const words = layers.length ? McpGrammar.merge(...layers) : undefined;
        for (const behavior of this._behaviors) {
            for (const tool of behavior.getTools()) {
                const inline = Boolean(tool.description && tool.description.trim());
                const filed = Boolean(words?.getToolDescription(tool.name));
                if (inline && filed) problems.push(`tool "${tool.name}" is described both inline and in grammar "${baselineKey}"`);
                if (!inline && !filed) problems.push(`tool "${tool.name}" has no description, inline or in grammar "${baselineKey}"`);
            }
            for (const resource of behavior.getResources()) {
                const inline = Boolean(resource.description && resource.description.trim());
                const filed = Boolean(words?.getResourceDescription(resource.uri));
                if (inline && filed) problems.push(`resource "${resource.uri}" is described both inline and in grammar "${baselineKey}"`);
                if (!inline && !filed) problems.push(`resource "${resource.uri}" has no description, inline or in grammar "${baselineKey}"`);
            }
        }
        return problems;
    }
}
