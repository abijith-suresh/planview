export function createDocumentAccountBoundary(reset: () => void) {
  let ownerId: string | null = null;
  return (nextOwnerId: string | null) => {
    if (nextOwnerId === ownerId) return;
    ownerId = nextOwnerId;
    reset();
  };
}
