/** What a list that GitHub gave in part says: how much is here, and a link to the rest. */
export function TruncatedNote({ label, href }: { label: string; href: string }) {
  return (
    <p className="mrpr-status mrpr-note">
      <a className="mrpr-link" href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    </p>
  );
}
