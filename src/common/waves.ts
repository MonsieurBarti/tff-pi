interface TaskRef {
	id: string;
	number: number;
}

interface DependencyRef {
	fromTaskId: string;
	toTaskId: string;
}

export function computeWaves(tasks: TaskRef[], dependencies: DependencyRef[]): Map<string, number> {
	if (tasks.length === 0) return new Map();

	const dependsOn = new Map<string, Set<string>>();
	const dependedBy = new Map<string, Set<string>>();

	for (const t of tasks) {
		dependsOn.set(t.id, new Set());
		dependedBy.set(t.id, new Set());
	}

	for (const dep of dependencies) {
		dependsOn.get(dep.fromTaskId)?.add(dep.toTaskId);
		dependedBy.get(dep.toTaskId)?.add(dep.fromTaskId);
	}

	const waves = new Map<string, number>();
	const remaining = new Set(tasks.map((t) => t.id));
	let currentWave = 1;

	while (remaining.size > 0) {
		const ready: string[] = [];
		for (const id of remaining) {
			const deps = dependsOn.get(id) ?? new Set<string>();
			const allResolved = [...deps].every((d) => !remaining.has(d));
			if (allResolved) {
				ready.push(id);
			}
		}

		if (ready.length === 0) {
			throw new Error("Cycle detected in task dependencies");
		}

		for (const id of ready) {
			waves.set(id, currentWave);
			remaining.delete(id);
		}

		currentWave++;
	}

	return waves;
}
