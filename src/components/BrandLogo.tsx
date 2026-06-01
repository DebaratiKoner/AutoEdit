interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  animated?: boolean;
}

export function BrandLogo({ size = 'md', animated = false }: BrandLogoProps) {
  const sizeClass = {
    sm: 'h-9 w-9 text-lg',
    md: 'h-12 w-12 text-2xl',
    lg: 'h-20 w-20 text-4xl',
  }[size];

  return (
    <div className={`ae-logo ${animated ? 'ae-logo-animated' : ''} ${sizeClass}`} aria-label="AutoEdit AI logo">
      <span className="ae-logo-mark">A</span>
      <span className="ae-logo-spark ae-logo-spark-one" />
      <span className="ae-logo-spark ae-logo-spark-two" />
    </div>
  );
}