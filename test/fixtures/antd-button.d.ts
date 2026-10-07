import { ButtonHTMLAttributes } from 'react';

// antd ships its Button API as a type alias + an interface that references it.
export type ButtonType = 'default' | 'primary' | 'dashed' | 'link' | 'text';
export type ButtonShape = 'default' | 'circle' | 'round';
export type ButtonSize = 'large' | 'middle' | 'small';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  type?: ButtonType;
  shape?: ButtonShape;
  size?: ButtonSize;
  disabled?: boolean;
  block?: boolean;
  danger?: boolean;
  onClick?: (e: MouseEvent) => void;
  children?: React.ReactNode;
}
