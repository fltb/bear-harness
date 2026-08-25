export type ResourceKind = "file" | "directory";
export type ResourceAccess = "read" | "read-write";
export type ResourcePersistence = "conversation" | "persistent";

export type ResourceOperation =
	| "list"
	| "read"
	| "create-child"
	| "modify"
	| "rename"
	| "move"
	| "delete";

export interface CommissionResourceGrant {
	resourceId: string;
	operations: ResourceOperation[];
	relativeScopes?: string[];
	baselineRevision?: string;
}

export interface OutputGrant {
	parentResourceId: string;
	relativePath?: string;
	mode: "create-new" | "modify-existing";
}

export interface ResolvedResourceGrant extends CommissionResourceGrant {
	resolvedPath: string;
	kind: ResourceKind;
	identityAtLaunch: FileIdentity;
	sha256AtLaunch?: string;
}
export type ResourceState =
	| "available"
	| "changed"
	| "moved"
	| "missing"
	| "replaced"
	| "permission_lost";

export interface FileIdentity {
	realpathAtGrant: string;
	volumeId?: string;
	fileId?: string;
	deviceId?: string;
	inode?: string;
}

export interface ResourceBaseline {
	exists: boolean;
	size?: number;
	mtimeMs?: number;
	sha256?: string;
}

export interface ResourceRef {
	id: string;
	kind: ResourceKind;
	displayName: string;
	access: ResourceAccess;
	persistence: ResourcePersistence;
	locator: { platform: NodeJS.Platform; canonicalPath: string; securityBookmark?: string };
	identity: FileIdentity;
	baseline: ResourceBaseline;
	state: ResourceState;
	grantedAt: string;
	lastResolvedAt?: string;
}

/** The only resource representation allowed across the renderer/model boundary. */
export interface ResourceRefView {
	id: string;
	kind: ResourceKind;
	displayName: string;
	access: ResourceAccess;
	persistence: ResourcePersistence;
	state: ResourceState;
	summary?: { mime?: string; bytes?: number; fileCount?: number };
}
