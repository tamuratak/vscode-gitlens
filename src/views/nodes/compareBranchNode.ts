'use strict';
import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ViewShowBranchComparison } from '../../configuration';
import { BranchComparison, BranchComparisons, GlyphChars, WorkspaceState } from '../../constants';
import { Container } from '../../container';
import { GitBranch, GitRevision } from '../../git/git';
import { GitUri } from '../../git/gitUri';
import { CommandQuickPickItem, ReferencePicker } from '../../quickpicks';
import { debug, gate, log, Strings } from '../../system';
import { BranchesView } from '../branchesView';
import { CommitsView } from '../commitsView';
import { RepositoriesView } from '../repositoriesView';
import { RepositoryNode } from './repositoryNode';
import { CommitsQueryResults, ResultsCommitsNode } from './resultsCommitsNode';
import { FilesQueryResults, ResultsFilesNode } from './resultsFilesNode';
import { ContextValues, ViewNode } from './viewNode';

export class CompareBranchNode extends ViewNode<BranchesView | CommitsView | RepositoriesView> {
	static key = ':compare-branch';
	static getId(repoPath: string, name: string, root: boolean): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}(${name})${root ? ':root' : ''}`;
	}

	private _children: ViewNode[] | undefined;
	private _compareWith: BranchComparison | undefined;

	constructor(
		uri: GitUri,
		view: BranchesView | CommitsView | RepositoriesView,
		parent: ViewNode,
		public readonly branch: GitBranch,
		private showComparison: ViewShowBranchComparison,
		// Specifies that the node is shown as a root
		public readonly root: boolean = false,
	) {
		super(uri, view, parent);

		this.loadCompareWith();
	}

	get ahead(): { readonly ref1: string; readonly ref2: string } {
		return {
			ref1: this._compareWith?.ref || 'HEAD',
			ref2: this.branch.ref,
		};
	}

	get behind(): { readonly ref1: string; readonly ref2: string } {
		return {
			ref1: this.branch.ref,
			ref2: this._compareWith?.ref || 'HEAD',
		};
	}

	override get id(): string {
		return CompareBranchNode.getId(this.branch.repoPath, this.branch.name, this.root);
	}

	get repoPath(): string {
		return this.branch.repoPath;
	}

	async getChildren(): Promise<ViewNode[]> {
		if (this._compareWith == null) return [];

		if (this._children == null) {
			const ahead = this.ahead;
			const behind = this.behind;

			const aheadBehindCounts = await Container.git.getAheadBehindCommitCount(this.branch.repoPath, [
				GitRevision.createRange(behind.ref1, behind.ref2, '...'),
			]);
			const mergeBase =
				(await Container.git.getMergeBase(this.repoPath, behind.ref1, behind.ref2, { forkPoint: true })) ??
				(await Container.git.getMergeBase(this.repoPath, behind.ref1, behind.ref2));

			this._children = [
				new ResultsCommitsNode(
					this.view,
					this,
					this.uri.repoPath!,
					'Behind',
					{
						query: this.getCommitsQuery(GitRevision.createRange(behind.ref1, behind.ref2, '..')),
						comparison: behind,
						direction: 'behind',
						files: {
							ref1: this.compareWithWorkingTree ? '' : mergeBase ?? behind.ref1,
							ref2: behind.ref2,
							query: this.getBehindFilesQuery.bind(this),
						},
					},
					{
						id: 'behind',
						description: Strings.pluralize('commit', aheadBehindCounts?.behind ?? 0),
						expand: false,
					},
				),
				new ResultsCommitsNode(
					this.view,
					this,
					this.uri.repoPath!,
					'Ahead',
					{
						query: this.getCommitsQuery(
							GitRevision.createRange(ahead.ref1, this.compareWithWorkingTree ? '' : ahead.ref2, '..'),
						),
						comparison: ahead,
						direction: 'ahead',
						files: {
							ref1: mergeBase ?? ahead.ref1,
							ref2: this.compareWithWorkingTree ? '' : ahead.ref2,
							query: this.getAheadFilesQuery.bind(this),
						},
					},
					{
						id: 'ahead',
						description: Strings.pluralize('commit', aheadBehindCounts?.ahead ?? 0),
						expand: false,
					},
				),
				new ResultsFilesNode(
					this.view,
					this,
					this.uri.repoPath!,
					this._compareWith.ref || 'HEAD',
					this.compareWithWorkingTree ? '' : this.branch.ref,
					this.getFilesQuery.bind(this),
					undefined,
					{
						expand: false,
					},
				),
			];
		}
		return this._children;
	}

	getTreeItem(): TreeItem {
		let state: TreeItemCollapsibleState;
		let label;
		let tooltip;
		if (this._compareWith == null) {
			label = `Compare ${
				this.compareWithWorkingTree ? 'Working Tree' : this.branch.name
			} with <branch, tag, or ref>`;
			state = TreeItemCollapsibleState.None;
			tooltip = `Click to compare ${
				this.compareWithWorkingTree ? 'Working Tree' : this.branch.name
			} with a branch, tag, or ref`;
		} else {
			label = `Compare ${
				this.compareWithWorkingTree ? 'Working Tree' : this.branch.name
			} with ${GitRevision.shorten(this._compareWith.ref, {
				strings: { working: 'Working Tree' },
			})}`;
			state = TreeItemCollapsibleState.Collapsed;
		}

		const item = new TreeItem(label, state);
		item.id = this.id;
		item.contextValue = `${ContextValues.CompareBranch}${this.branch.current ? '+current' : ''}+${
			this.comparisonType
		}${this._compareWith == null ? '' : '+comparing'}${this.root ? '+root' : ''}`;

		if (this._compareWith == null) {
			item.command = {
				title: `Compare ${this.branch.name}${this.compareWithWorkingTree ? ' (working)' : ''} with${
					GlyphChars.Ellipsis
				}`,
				command: 'gitlens.views.editNode',
				arguments: [this],
			};
		}

		item.iconPath = new ThemeIcon('git-compare');
		item.tooltip = tooltip;

		return item;
	}

	@log()
	async clear() {
		if (this._compareWith == null) return;

		this._compareWith = undefined;
		await this.updateCompareWith(undefined);

		this._children = undefined;
		this.view.triggerNodeChange(this);
	}

	@log()
	async edit() {
		await this.compareWith();
	}

	@gate()
	@debug()
	override refresh() {
		this._children = undefined;
		this.loadCompareWith();
	}

	@log()
	async setComparisonType(comparisonType: Exclude<ViewShowBranchComparison, false>) {
		if (this._compareWith != null) {
			await this.updateCompareWith({ ...this._compareWith, type: comparisonType });
		} else {
			this.showComparison = comparisonType;
		}

		this._children = undefined;
		this.view.triggerNodeChange(this);
	}

	private get comparisonType() {
		return this._compareWith?.type ?? this.showComparison;
	}

	private get compareWithWorkingTree() {
		return this.comparisonType === ViewShowBranchComparison.Working;
	}

	private async compareWith() {
		const pick = await ReferencePicker.show(
			this.branch.repoPath,
			`Compare ${this.branch.name}${this.compareWithWorkingTree ? ' (working)' : ''} with`,
			'Choose a reference to compare with',
			{
				allowEnteringRefs: true,
				picked: this.branch.ref,
				// checkmarks: true,
				sort: { branches: { current: true }, tags: {} },
			},
		);
		if (pick == null || pick instanceof CommandQuickPickItem) return;

		await this.updateCompareWith({
			ref: pick.ref,
			notation: undefined,
			type: this.comparisonType,
		});

		this._children = undefined;
		this.view.triggerNodeChange(this);
	}

	private async getAheadFilesQuery(): Promise<FilesQueryResults> {
		let files = await Container.git.getDiffStatus(
			this.repoPath,
			GitRevision.createRange(this._compareWith?.ref || 'HEAD', this.branch.ref || 'HEAD', '...'),
		);

		if (this.compareWithWorkingTree) {
			const workingFiles = await Container.git.getDiffStatus(this.repoPath, 'HEAD');
			if (workingFiles != null) {
				if (files != null) {
					for (const wf of workingFiles) {
						const index = files.findIndex(f => f.fileName === wf.fileName);
						if (index !== -1) {
							files.splice(index, 1, wf);
						} else {
							files.push(wf);
						}
					}
				} else {
					files = workingFiles;
				}
			}
		}

		return {
			label: `${Strings.pluralize('file', files?.length ?? 0, { zero: 'No' })} changed`,
			files: files,
		};
	}

	private async getBehindFilesQuery(): Promise<FilesQueryResults> {
		const files = await Container.git.getDiffStatus(
			this.uri.repoPath!,
			GitRevision.createRange(this.branch.ref, this._compareWith?.ref || 'HEAD', '...'),
		);

		return {
			label: `${Strings.pluralize('file', files?.length ?? 0, { zero: 'No' })} changed`,
			files: files,
		};
	}

	private getCommitsQuery(range: string): (limit: number | undefined) => Promise<CommitsQueryResults> {
		const repoPath = this.uri.repoPath!;
		return async (limit: number | undefined) => {
			const log = await Container.git.getLog(repoPath, {
				limit: limit,
				ref: range,
			});

			const results: Mutable<Partial<CommitsQueryResults>> = {
				log: log,
				hasMore: log?.hasMore ?? true,
			};
			if (results.hasMore) {
				results.more = async (limit: number | undefined) => {
					results.log = (await results.log?.more?.(limit)) ?? results.log;
					results.hasMore = results.log?.hasMore ?? true;
				};
			}

			return results as CommitsQueryResults;
		};
	}

	private async getFilesQuery(): Promise<FilesQueryResults> {
		let comparison;
		if (this._compareWith!.ref === '') {
			comparison = this.branch.ref;
		} else if (this.compareWithWorkingTree) {
			comparison = this._compareWith!.ref;
		} else {
			comparison = `${this._compareWith!.ref}...${this.branch.ref}`;
		}

		const files = await Container.git.getDiffStatus(this.uri.repoPath!, comparison);

		return {
			label: `${Strings.pluralize('file', files?.length ?? 0, { zero: 'No' })} changed`,
			files: files,
		};
	}

	private loadCompareWith() {
		const comparisons = Container.context.workspaceState.get<BranchComparisons>(WorkspaceState.BranchComparisons);

		const id = `${this.branch.id}${this.branch.current ? '+current' : ''}`;
		const compareWith = comparisons?.[id];
		if (compareWith != null && typeof compareWith === 'string') {
			this._compareWith = {
				ref: compareWith,
				notation: undefined,
				type: this.showComparison,
			};
		} else {
			this._compareWith = compareWith;
		}
	}

	private async updateCompareWith(compareWith: BranchComparison | undefined) {
		this._compareWith = compareWith;

		let comparisons = Container.context.workspaceState.get<BranchComparisons>(WorkspaceState.BranchComparisons);
		if (comparisons == null) {
			comparisons = Object.create(null) as BranchComparisons;
		}

		const id = `${this.branch.id}${this.branch.current ? '+current' : ''}`;

		if (compareWith != null) {
			comparisons[id] = { ...compareWith };
		} else {
			const { [id]: _, ...rest } = comparisons;
			comparisons = rest;
		}
		await Container.context.workspaceState.update(WorkspaceState.BranchComparisons, comparisons);
	}
}
