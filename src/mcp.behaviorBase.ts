import type { IMcpBehavior, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "./interfaces";
import { McpToolResults } from "./mcp.toolResult";

export type McpBehaviorOptions = {
    domain?: string; // e.g. "iot", "game", "vr", "ar", "generic"
    namespace?: string; // e.g. "scene", "characters",..
    name?: string;
    description?: string;
    mimeType?: string;
};

export class McpBehaviorOptionsBuilder {
    private _domain?: string;
    private _namespace?: string;
    private _name?: string;
    private _description?: string;
    private _mimeType?: string;

    public constructor(domain?: string, namespace?: string) {
        this._domain = domain;
        this._namespace = namespace;
    }

    public withDomain(domain: string): this {
        this._domain = domain;
        return this;
    }

    public withNamespace(namespace: string): this {
        this._namespace = namespace;
        return this;
    }

    public withName(name: string): this {
        this._name = name;
        return this;
    }

    public withDescription(description: string): this {
        this._description = description;
        return this;
    }

    public withMimeType(mimeType: string): this {
        this._mimeType = mimeType;
        return this;
    }

    public build(): McpBehaviorOptions {
        return {
            domain: this._domain,
            namespace: this._namespace,
            name: this._name,
            description: this._description,
            mimeType: this._mimeType,
        };
    }
}

export class McpBehaviorBase implements IMcpBehavior {
    private _domain?: string;
    private _namespace?: string;
    private _name?: string;
    private _description?: string;
    private _mimeType?: string;
    private _baseUri?: string;

    public constructor(options: McpBehaviorOptions) {
        this._domain = options.domain;
        this._namespace = options.namespace;
        this._name = options.name;
        this._description = options.description;
        this._mimeType = options.mimeType;
    }

    public get baseUri(): string {
        if (!this._baseUri) {
            this._baseUri = this._buildBaseUri();
        }
        return this._baseUri!;
    }

    public get domain(): string {
        return this._domain || "mcp";
    }

    public get namespace(): string {
        return this._namespace || "";
    }

    public get name(): string | undefined {
        return this._name;
    }

    public get description(): string | undefined {
        return this._description;
    }

    public get mimeType(): string | undefined {
        return this._mimeType;
    }

    public readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return Promise.resolve(undefined);
    }

    public executeToolAsync(_uri: string, _toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        return Promise.resolve(McpToolResults.error(`Tool not implemented: ${_toolName}`));
    }

    public getResources(): McpResource[] {
        throw new Error("Method not implemented.");
    }

    public getResourceTemplates(): McpResourceTemplate[] {
        throw new Error("Method not implemented.");
    }

    public getTools(): McpTool[] {
        throw new Error("Method not implemented.");
    }

    protected _buildBaseUri(): string {
        return `${this.domain}://${this.namespace}`;
    }
}
