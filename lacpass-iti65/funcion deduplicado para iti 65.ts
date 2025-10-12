--- index.js
+++ index.js
@@ -1000,6 +1000,34 @@
   return entry && entry.resource?.meta?.profile && !entry.resource.meta.profile.includes(profileUrl);
 }

+// --- Post-processing: dedupe de entries en TODAS las secciones del Composition ---
+function dedupeAllSectionEntries(composition) {
+  if (!composition?.section) return;
+  for (const sec of composition.section) {
+    if (Array.isArray(sec.entry)) {
+      sec.entry = sec.entry.filter((e, i, arr) => i === arr.findIndex(v => v.reference === e.reference));
+    }
+  }
+}
+
+// Helper: referencias ya usadas en otra sección (p.ej. evitar que 11348-0 repita lo de 11450-4)
+function getSectionRefs(composition, loincCode) {
+  const sec = (composition?.section || []).find(s =>
+    s?.code?.coding?.some(c => c.system === 'http://loinc.org' && c.code === loincCode)
+  );
+  return new Set((sec?.entry || []).map(e => e.reference));
+}
+
 // -------------------------------------------------------------------------------

@@ -1108,9 +1136,17 @@
   if (allowedTypes.includes('Condition')) {
     const isPast = loincCode === LOINC_CODES.PAST_ILLNESS_SECTION;
     const conds = candidates.filter(x => x.resource?.resourceType === 'Condition');
+    // Evitar solapamiento: lo que ya esté en PROBLEMS no debe ir a PAST
+    const problemsRefs = getSectionRefs(composition, LOINC_CODES.PROBLEMS_SECTION);

     if (!isPast) {
       // Problems (11450-4): prefer active, exclude absent-unknown
       const active = conds.filter(x => isActiveProblem(x.resource) && !isAbsentProblemCondition(x.resource));
       if (active.length > 0) {
@@ -1132,7 +1168,12 @@
     } else {
       // Past Illness (11348-0): include inactive/resolved or with abatement; exclude absent-unknown
-      const past = conds.filter(x => isPastIllness(x.resource) && !isAbsentProblemCondition(x.resource));
+      const past = conds.filter(x =>
+        isPastIllness(x.resource) &&
+        !isAbsentProblemCondition(x.resource) &&
+        !problemsRefs.has(x.fullUrl) // no repetir lo que ya está en Problemas
+      );
       if (past.length > 0) {
         sec.entry = Array.isArray(sec.entry) ? sec.entry : [];
         for (const candidate of past) {
@@ -1219,6 +1260,14 @@
   }
 }
 
+// Llamar al dedupe global después de construir el Composition
+function finalizeComposition(composition) {
+  dedupeAllSectionEntries(composition);
+  return composition;
+}
+
 // Donde sea que retornes el Composition final, envuélvelo con finalizeComposition:
 // por ejemplo, si tenías:
-//   return composition;
+//   return finalizeComposition(composition);
