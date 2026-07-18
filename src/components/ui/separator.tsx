import * as React from "react";

import { cn } from "@/lib/utils";

const Separator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full", className)} data-orientation="horizontal" {...props} />
  ),
);
Separator.displayName = "Separator";

export { Separator };
