export class StateBranchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateBranchError";
	}
}

export function stateBranchName(codeBranch: string): string {
	return `tff-state/${codeBranch}`;
}
