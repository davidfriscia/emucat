import { BrandMark } from '../components/BrandMark';

export function CatalogPage() {
  return (
    <>
      <h1 className="h3 mb-4">Catalog</h1>
      <section className="empty-state text-center rounded-3 border px-3 py-5">
        <BrandMark size={64} />
        <h2 className="h5 mt-3">No virtual machines yet</h2>
        <p className="text-body-secondary mx-auto mb-0 empty-state-text">
          A virtual machine joins the catalog after the EmuCat agent discovers it and you register
          it. Agent discovery and registration are not available in this version.
        </p>
      </section>
    </>
  );
}
