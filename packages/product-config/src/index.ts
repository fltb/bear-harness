/**
 * Release identity and the default character-package selector.
 *
 * Character names, visual identity, copy, scenes, and other character
 * content belong to `config/characters/<id>`, not this product identity
 * boundary. `defaultCharacterId` only selects the package to load.
 */
export interface BrandLicense {
	spdx: "CC-BY-SA-4.0";
	workTitle: string;
	creator: string;
	attribution: string;
	sourceUrl: string;
	modified: boolean;
	modificationNotice: string;
}

export interface UpdatePublisherPolicy {
	algorithm: "ed25519";
	/** PEM-encoded Ed25519 SubjectPublicKeyInfo. */
	publicKey: string;
}

export interface ProductConfig {
	productName: string;
	appId: string;
	dataDirectoryName: string;
	artifactName: string;
	executableName: string;
	/** Selects a character package; character content remains in that package. */
	defaultCharacterId: string;
	brandLicense: BrandLicense;
	icon: string | null;
	/**
	 * Optional JSON update feed URL for the desktop auto-update service.
	 * Empty string (the default) disables update checks entirely.
	 */
	updateFeedUrl?: string;
	/** Required when updateFeedUrl is non-empty. */
	updatePublisher?: UpdatePublisherPolicy;
}

export interface ProductConfigValidationError {
	field: string;
	reason: string;
}

export type ProductIdentityReference = Pick<
	ProductConfig,
	| "productName"
	| "appId"
	| "dataDirectoryName"
	| "artifactName"
	| "executableName"
	| "defaultCharacterId"
	| "brandLicense"
	| "icon"
>;

/**
 * Official upstream brand snapshot used as the fork-identity reference.
 * Kept as plain frozen data so build scripts and the runtime validator share
 * one source of truth without importing the live config for constants.
 */
export const OFFICIAL_BRAND: Readonly<ProductIdentityReference> = Object.freeze({
	productName: "Cyber Bear",
	appId: "io.github.fltb.bear-harness",
	dataDirectoryName: "cyber-bear",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "cyber-bear",
	defaultCharacterId: "jizhou",
	brandLicense: Object.freeze({
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	}),
	icon: "packages/product-config/assets/icon.png",
});

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;
const BRAND_LICENSE_FIELDS = [
	"spdx",
	"workTitle",
	"creator",
	"attribution",
	"sourceUrl",
	"modified",
	"modificationNotice",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isEd25519PublicKey(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() === "") return false;
	const match = value
		.trim()
		.match(/^-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PUBLIC KEY-----$/);
	if (!match) return false;
	const body = match[1]?.replace(/\s/g, "") ?? "";
	return body.length > 0 && body.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}

/** Return all actionable shape and identity errors without touching the filesystem. */
export function validateProductConfig(
	value: unknown,
	official?: ProductIdentityReference,
): ProductConfigValidationError[] {
	const errors: ProductConfigValidationError[] = [];
	const fail = (field: string, reason: string) => errors.push({ field, reason });
	if (!isRecord(value)) {
		return [{ field: "productConfig", reason: "must be an object" }];
	}

	for (const field of [
		"productName",
		"appId",
		"dataDirectoryName",
		"artifactName",
		"executableName",
		"defaultCharacterId",
	] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
			fail(field, "must be a non-empty string");
		}
	}
	if (typeof value.appId === "string" && !APP_ID_RE.test(value.appId)) {
		fail(
			"appId",
			`must be reverse-domain ( ${APP_ID_RE.source} ), got ${JSON.stringify(value.appId)}`,
		);
	}
	for (const field of ["dataDirectoryName", "executableName", "defaultCharacterId"] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue === "string" && !KEBAB_RE.test(fieldValue)) {
			fail(field, `must be ASCII kebab-case, got ${JSON.stringify(fieldValue)}`);
		}
	}
	if (typeof value.artifactName === "string") {
		for (const macro of ["${version}", "${os}", "${arch}", "${ext}"]) {
			if (!value.artifactName.includes(macro)) fail("artifactName", `must contain ${macro}`);
		}
	}

	const brandLicense = value.brandLicense;
	if (!isRecord(brandLicense)) {
		fail("brandLicense", "must be an object");
	} else {
		for (const field of Object.keys(brandLicense)) {
			if (!(BRAND_LICENSE_FIELDS as readonly string[]).includes(field)) {
				fail("brandLicense", `must not contain unknown field ${JSON.stringify(field)}`);
			}
		}
		if (brandLicense.spdx !== "CC-BY-SA-4.0") {
			fail("brandLicense.spdx", 'must be exactly "CC-BY-SA-4.0"');
		}
		for (const field of ["workTitle", "creator", "attribution", "sourceUrl"] as const) {
			const fieldValue = brandLicense[field];
			if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
				fail(`brandLicense.${field}`, "must be a non-empty string");
			}
		}
		if (typeof brandLicense.modified !== "boolean")
			fail("brandLicense.modified", "must be a boolean");
		if (typeof brandLicense.modificationNotice !== "string") {
			fail("brandLicense.modificationNotice", "must be a string");
		}
	}

	if (value.icon === undefined) {
		fail("icon", "must be explicitly null or a non-empty repo-relative path");
	} else if (value.icon !== null) {
		if (typeof value.icon !== "string" || value.icon.trim() === "") {
			fail("icon", "must be null or a non-empty repo-relative path");
		} else if (value.icon.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value.icon)) {
			fail("icon", `must be a repository-relative path, got ${JSON.stringify(value.icon)}`);
		} else if (value.icon.split(/[\\/]+/).includes("..")) {
			fail("icon", `must not escape the repository, got ${JSON.stringify(value.icon)}`);
		}
	}

	const hasFeed = "updateFeedUrl" in value;
	const feed = value.updateFeedUrl;
	if (hasFeed && typeof feed !== "string") {
		fail("updateFeedUrl", "must be an empty string or a valid HTTPS URL");
	} else if (typeof feed === "string" && feed !== "") {
		try {
			const parsed = new URL(feed);
			if (parsed.protocol !== "https:" || parsed.hostname === "") throw new Error("not HTTPS");
		} catch {
			fail("updateFeedUrl", "must be an empty string or a valid HTTPS URL");
		}
	}

	const hasPublisher = "updatePublisher" in value;
	const publisher = value.updatePublisher;
	if (hasPublisher) {
		if (!isRecord(publisher)) {
			fail("updatePublisher", "must be an object");
		} else {
			for (const field of Object.keys(publisher)) {
				if (field !== "algorithm" && field !== "publicKey") {
					fail("updatePublisher", `must not contain unknown field ${JSON.stringify(field)}`);
				}
			}
			if (publisher.algorithm !== "ed25519") {
				fail("updatePublisher.algorithm", 'must be exactly "ed25519"');
			}
			if (!isEd25519PublicKey(publisher.publicKey)) {
				fail("updatePublisher.publicKey", "must be a PEM-encoded Ed25519 public key");
			}
		}
	}
	if (typeof feed === "string" && feed !== "" && !hasPublisher) {
		fail("updatePublisher", "is required when updateFeedUrl is non-empty");
	}

	if (official && isRecord(brandLicense)) {
		const identityFields: Array<keyof ProductIdentityReference> = [
			"productName",
			"appId",
			"dataDirectoryName",
			"artifactName",
			"executableName",
			"defaultCharacterId",
			"brandLicense",
			"icon",
		];
		const changed = identityFields.some((field) => !sameValue(value[field], official[field]));
		if (changed) {
			if (value.appId === official.appId) {
				fail("appId", "must differ from the official value when any identity field changes");
			}
			if (value.dataDirectoryName === official.dataDirectoryName) {
				fail(
					"dataDirectoryName",
					"must differ from the official value when any identity field changes",
				);
			}
			if (brandLicense.modified !== true) {
				fail("brandLicense.modified", "must be true when any identity field changes");
			}
			if (
				typeof brandLicense.modificationNotice !== "string" ||
				brandLicense.modificationNotice.trim() === ""
			) {
				fail("brandLicense.modificationNotice", "must be non-empty when modified is true");
			}
		} else if (brandLicense.modified === true) {
			fail(
				"brandLicense.modified",
				"must be false when all identity fields match the official values",
			);
		}
	}
	return errors;
}

export function assertProductConfig(
	value: unknown,
	official?: ProductIdentityReference,
): asserts value is ProductConfig {
	const errors = validateProductConfig(value, official);
	if (errors.length > 0) {
		throw new Error(errors.map(({ field, reason }) => `${field}: ${reason}`).join("; "));
	}
}

export const productConfig: ProductConfig = {
	productName: "Cyber Bear",
	appId: "io.github.fltb.bear-harness",
	dataDirectoryName: "cyber-bear",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "cyber-bear",
	defaultCharacterId: "jizhou",
	brandLicense: {
		spdx: "CC-BY-SA-4.0",
		workTitle: "Cyber Bear Brand Assets",
		creator: "fltb",
		attribution: "fltb — Cyber Bear Brand Assets",
		sourceUrl: "https://github.com/fltb/bear-harness",
		modified: false,
		modificationNotice: "",
	},
	icon: "packages/product-config/assets/icon.png",
	updateFeedUrl: "",
};
