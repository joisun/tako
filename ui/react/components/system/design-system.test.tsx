import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'

import { Button } from '../ui/button'
import { TabsTrigger, TabsList, Tabs } from '../ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

describe('Dashboard design system', () => {
  test('uses compact controls without losing accessible names', () => {
    render(
      <div>
        <Button>Continue</Button>
        <Button isIconOnly aria-label="Open settings">S</Button>
      </div>,
    )

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('h-8')
    expect(screen.getByRole('button', { name: 'Open settings' })).toHaveAttribute('data-icon-only')
    expect(screen.getByRole('button', { name: 'Open settings' })).toHaveClass('h-8', 'p-0')
  })

  test('makes tooltip content available from keyboard focus', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip>
        <TooltipTrigger delay={0} render={<Button />}>Inspect</TooltipTrigger>
        <TooltipContent>Inspect task details</TooltipContent>
      </Tooltip>,
    )

    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Inspect task details')
  })

  test('supports arrow-key navigation between tabs', async () => {
    const user = userEvent.setup()
    render(
      <Tabs defaultValue="tasks">
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const tasks = screen.getByRole('tab', { name: 'Tasks' })
    const scheduled = screen.getByRole('tab', { name: 'Scheduled' })
    tasks.focus()
    await user.keyboard('{ArrowRight}')
    expect(scheduled).toHaveFocus()
  })

  test('defines the semantic dashboard token contract', async () => {
    const source = await readFile(resolve('ui/react/styles/tokens.css'), 'utf8')
    for (const token of [
      '--surface-0',
      '--surface-1',
      '--border-subtle',
      '--text-primary',
      '--text-muted',
      '--accent',
      '--danger',
      '--success',
      '--row-height',
      '--control-height',
    ]) {
      expect(source).toContain(token)
    }
  })
})
