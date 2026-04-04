// ---------------------------------------------------------------------------
// Plugin manifest types
//
// The manifest is the complete declaration of what a plugin does.
// No hidden side effects — you can audit a plugin by reading its manifest.
// ---------------------------------------------------------------------------

/** UI slot locations where plugins can inject components. */
export type SlotLocation =
  | "app.detail.sidebar"
  | "app.detail.tabs"
  | "app.detail.actions"
  | "app.detail.info"
  | "project.detail.tabs"
  | "settings.sections"
  | "admin.sections"
  | "dashboard.cards"
  | "deploy.log.annotations";

/** Predefined component types that plugins can render. */
export type SlotComponentType =
  | "status-badge"
  | "metric-card"
  | "data-table"
  | "form-section"
  | "action-button"
  | "key-value-row"
  | "inline-alert"
  | "link"
  | "iframe";

/** A slot injection — adds new UI to a defined location. */
export type SlotDeclaration = {
  component: SlotComponentType;
  props: Record<string, unknown>;
};

/** Decorator positions for modifying existing UI. */
export type DecoratorPosition = "prepend" | "append" | "replace";

/** A decorator — modifies an existing UI element. */
export type DecoratorDeclaration = {
  position: DecoratorPosition;
  component: SlotComponentType;
  props: Record<string, unknown>;
  /** Conditional rendering — evaluated at render time. */
  when?: Record<string, unknown>;
};

/** Plugin settings field types. */
export type SettingFieldType = "toggle" | "text" | "textarea" | "select" | "number" | "password";

/** A plugin settings field declaration. */
export type PluginSettingField = {
  key: string;
  type: SettingFieldType;
  label: string;
  description?: string;
  default?: unknown;
  options?: { label: string; value: string }[];
  required?: boolean;
};

/** Service dependency — infrastructure the plugin needs. */
export type ServiceRequirement = {
  name: string;
  /** How to verify the service is available. */
  check: "http" | "redis" | "tcp";
  /** Default endpoint URL. */
  default: string;
  /** Plugin setting key for user-configured endpoint. */
  setting: string;
  /** Can Vardo auto-add this to the compose stack? */
  provisionable: boolean;
};

/** Hook declaration in the manifest. */
export type ManifestHook = {
  event: string;
  handler: string;
  priority?: number;
  failMode?: "fail" | "warn" | "ignore";
};

/** Navigation item. */
export type ManifestNavItem = {
  label: string;
  icon: string;
  path: string;
  scope: "app" | "org" | "admin";
};

/** The full plugin manifest. */
export type PluginManifest = {
  id: string;
  name: string;
  description?: string;
  version: string;
  category?: string;

  /** What capability this plugin provides. */
  provides?: string[];
  /** Plugins that can't be active simultaneously. */
  conflicts?: string[];

  /** Infrastructure requirements — checked at enable time. */
  requires?: {
    services?: ServiceRequirement[];
    redis?: boolean;
    /** Other plugin capabilities that must be active. */
    features?: string[];
  };

  /** Backend: lifecycle hooks this plugin listens to. */
  hooks?: ManifestHook[];

  /**
   * Hook points this plugin emits (other plugins can register for these).
   * Purely declarative — tells the admin UI and plugin marketplace what
   * extension points are available. The engine doesn't enforce this;
   * any string works as a hook event.
   */
  emits?: string[];

  /** Backend: stream consumer groups. */
  consumers?: Array<{
    stream: string;
    group: string;
    handler: string;
  }>;

  /** Backend: API endpoints. */
  api?: Array<{
    method: string;
    path: string;
    handler: string;
  }>;

  /** Frontend: UI contributions. */
  ui?: {
    settings?: PluginSettingField[];
    slots?: Partial<Record<SlotLocation, SlotDeclaration>>;
    decorators?: Record<string, DecoratorDeclaration>;
    dashboard?: SlotDeclaration;
    nav?: ManifestNavItem[];
  };
};
