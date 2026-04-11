import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

function SkillsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: api.skills,
  });

  const skills = data?.skills ?? [];

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
        <p className="text-sm text-muted-foreground">
          {skills.length} skills installed in <code>~/.hermes/skills/</code>
        </p>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading skills…</p>
      )}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {skills.map((s) => (
          <Card key={s.name}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="size-4 text-fuchsia-400" />
                {s.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {s.preview && (
                <p className="line-clamp-3 text-[11px] text-muted-foreground">
                  {s.preview}
                </p>
              )}
              <Badge variant="outline" className="mt-2 font-mono text-[10px]">
                {s.path.replace(/^.*\/skills\//, "")}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
