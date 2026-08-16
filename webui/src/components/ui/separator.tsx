// webui/src/components/ui/separator.tsx
//
// A horizontal rule that is announced as one. The shell divides exactly one
// thing -- the sidebar identity from the panel navigation below it -- so there
// is no orientation prop and no vertical form to keep working.

import type React from 'react';

export function Separator(): React.ReactElement {
	return <div className="h-px w-full shrink-0 bg-border" data-slot="separator" role="separator" />;
}
