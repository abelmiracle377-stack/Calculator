import { superdevClient } from "@/lib/superdev/client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function BrandingBadge() {
  const showBranding = superdevClient.options.showBranding !== false;
  const affiliateId = superdevClient.options.affiliateId || "";
  
  if (!showBranding) return null;

  return (
    <a
      href={`https://www.buildy.ai?via=${affiliateId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-4 right-4 z-[9999] flex items-center gap-2 px-3 py-2 bg-black/80 backdrop-blur-sm border border-white/20 rounded-full hover:bg-black transition-all group scale-90 sm:scale-100 origin-bottom-right"
    >
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded-sm flex items-center justify-center">
            <img src="https://www.buildy.ai/_next/image?url=%2Fbuildys_head.png&w=256&q=75" alt="Buildy Logo" />
        </div>
        <span className="text-[12px] font-bold text-white/90">Built with Buildy.ai</span>
      </div>
    </a>
  );
}