export function formatDuration(ms: number): string {
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return `${min}m${rem > 0 ? `${rem}s` : ""}`;
}
