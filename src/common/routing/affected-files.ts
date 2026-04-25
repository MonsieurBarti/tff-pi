export interface AffectedFilesEstimate {
	files: string[];
	taskCount: number;
	count: number;
}

const TASK_HEADER_RE = /^(?:#{2,3}\s+Task\b|\d+\.\s+Task\b)/gm;
const FILE_PATH_RE =
	/\b(?:src|tests|scripts|packages)\/[\w\-/.]+\.(?:ts|tsx|js|mjs|yml|yaml|json|md)\b/g;

export function estimateAffectedFiles(planText: string): AffectedFilesEstimate {
	if (!planText) return { files: [], taskCount: 0, count: 0 };

	const taskCount = (planText.match(TASK_HEADER_RE) ?? []).length;
	const matches = planText.match(FILE_PATH_RE) ?? [];
	const files = Array.from(new Set(matches));

	return {
		files,
		taskCount,
		count: Math.max(files.length, taskCount),
	};
}
