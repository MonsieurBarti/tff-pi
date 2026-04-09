/**
 * TFF PI Extension Types
 */

/**
 * Extension configuration
 */
export interface ExtensionConfig {
	/** Whether the extension is enabled */
	enabled: boolean;
}

/**
 * Extension state (persisted across session)
 */
export interface ExtensionState {
	/** Whether the extension has been initialized */
	initialized: boolean;
	/** Extension configuration */
	config: ExtensionConfig;
}

/**
 * Tool result details for state persistence
 */
export interface ToolResultDetails {
	/** Action that was performed */
	action: string;
	/** Items affected by the action */
	items?: unknown[];
	/** Created item (for create action) */
	created?: string;
	/** Error message (if any) */
	error?: string;
}
