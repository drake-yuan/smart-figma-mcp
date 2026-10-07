import * as React from 'react';

// mui references its unions through named aliases (ButtonVariant) AND wraps them
// in OverridableStringUnion<...>, which otherwise decays to `string` at the type
// level. One prop also uses an inline literal union to exercise that path.
export type ButtonVariant = 'text' | 'outlined' | 'contained';
export type ButtonColor = 'inherit' | 'primary' | 'secondary' | 'success' | 'error' | 'info' | 'warning';
export type ButtonSize = 'small' | 'medium' | 'large';

export interface ButtonProps {
  variant?: OverridableStringUnion<ButtonVariant>;
  color?: OverridableStringUnion<ButtonColor>;
  size?: OverridableStringUnion<ButtonSize>;
  loadingPosition?: OverridableStringUnion<'center' | 'end' | 'start'>;
  disabled?: boolean;
  fullWidth?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children?: React.ReactNode;
}
