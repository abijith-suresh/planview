export type DocumentPage<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
  splitCursor?: string | null;
};

type PageOptions = { cursor: string | null; numItems: number; id: number; endCursor?: string };
type Page<T> = {
  result?: DocumentPage<T>;
  stop?: () => void;
  children?: [Page<T>, Page<T>];
  active: boolean;
};

export function createDocumentPages<T extends { _id: string }>(dependencies: {
  subscribe(
    options: PageOptions,
    update: (page: DocumentPage<T>) => void,
    error: (error: Error) => void
  ): () => void;
  update(state: {
    documents: T[];
    hasMore: boolean;
    loadingMore: boolean;
    initialLoading: boolean;
  }): void;
  error(error: Error): void;
  id: number;
}) {
  const pages: Page<T>[] = [];
  let closed = false;

  const completeResults = (page: Page<T>): DocumentPage<T>[] | undefined => {
    if (page.children) {
      const left = completeResults(page.children[0]);
      const right = completeResults(page.children[1]);
      if (left && right) return [...left, ...right];
      // Recommended splits can keep their complete old result while loading.
      if (page.result && page.result.pageStatus !== "SplitRequired") return [page.result];
      return undefined;
    }
    return page.result ? [page.result] : undefined;
  };

  const isSplitting = (page: Page<T>): boolean =>
    !!page.children &&
    (!completeResults(page.children[0]) ||
      !completeResults(page.children[1]) ||
      page.children.some(isSplitting));

  const retireSplitParents = (page: Page<T>) => {
    if (!page.children) return;
    page.children.forEach(retireSplitParents);
    if (page.active && completeResults(page.children[0]) && completeResults(page.children[1])) {
      page.active = false;
      page.stop?.();
      delete page.stop;
    }
  };

  const publish = () => {
    const documents = new Map<string, T>();
    let last: DocumentPage<T> | undefined;
    let waiting = false;
    for (const page of pages) {
      const results = completeResults(page);
      if (!results) {
        waiting = true;
        break;
      }
      for (const result of results) {
        for (const document of result.page) documents.set(document._id, document);
        last = result;
      }
      waiting ||= isSplitting(page);
    }
    pages.forEach(retireSplitParents);
    dependencies.update({
      documents: [...documents.values()],
      hasMore: last ? !last.isDone : true,
      loadingMore: waiting,
      initialLoading: !completeResults(pages[0]!),
    });
  };

  const stopPage = (page: Page<T>) => {
    page.active = false;
    page.stop?.();
    page.children?.forEach(stopPage);
  };

  const subscribePage = (page: Page<T>, options: PageOptions) => {
    page.stop = dependencies.subscribe(
      options,
      (result) => {
        if (closed || !page.active) return;
        page.result = result;
        if (
          !page.children &&
          result.splitCursor &&
          (result.pageStatus === "SplitRequired" || result.pageStatus === "SplitRecommended")
        ) {
          const left: Page<T> = { active: true };
          const right: Page<T> = { active: true };
          page.children = [left, right];
          subscribePage(left, { ...options, endCursor: result.splitCursor });
          subscribePage(right, {
            ...options,
            cursor: result.splitCursor,
            endCursor: options.endCursor ?? result.continueCursor,
          });
        }
        publish();
      },
      (error) => {
        if (closed || !page.active) return;
        const root = pages.at(-1);
        const contains = (candidate: Page<T>): boolean =>
          candidate === page || !!candidate.children?.some(contains);
        if (root && pages.length > 1 && contains(root) && (!root.result || root.children)) {
          pages.pop();
          stopPage(root);
          publish();
        }
        dependencies.error(error);
      }
    );
  };

  const addPage = (cursor: string | null) => {
    const page: Page<T> = { active: true };
    pages.push(page);
    subscribePage(page, { cursor, numItems: 50, id: dependencies.id });
  };

  addPage(null);

  return {
    loadMore() {
      const root = pages.at(-1);
      if (closed || !root || pages.some(isSplitting)) return;
      const last = completeResults(root)?.at(-1);
      if (!last || last.isDone) return;
      addPage(last.continueCursor);
      publish();
    },
    close() {
      closed = true;
      pages.forEach(stopPage);
      pages.length = 0;
    },
  };
}
